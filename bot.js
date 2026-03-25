/**
 * CitadelPay v17 - Discord Lightning Payment Bot (SQLite)
 *
 * Features:
 * - Deposit/Withdraw via Lightning
 * - Tip users with sats
 * - Emoji reactions for tipping
 * - Multi-language support (EN/KO/JA/ES)
 * - Smart fees (Blink internal = free)
 * - SQLite storage (migrated from JSON)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const qrcode = require("qrcode");
const bolt11 = require("light-bolt11-decoder");
const Database = require("better-sqlite3");

const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Partials
} = require("discord.js");

// ============ Config ============
const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    ownerId: process.env.OWNER_DISCORD_ID
  },
  blink: {
    apiKey: process.env.BLINK_API_KEY,
    endpoint: process.env.BLINK_API_ENDPOINT || "https://api.blink.sv/graphql"
  },
  limits: {
    maxWithdraw: 30000,
    invoiceExpiry: 60 * 60 * 1000,   // 60 min
    pollInterval: 5000               // 5 sec
  },
  fees: {
    internal: 0,
    external: 5
  },
  emojiTips: {
    "⚡": 21,
    "CP_1ZAP": 1,
    "CP_8ZAP": 8,
    "CP_21ZAP": 21,
    "CP_210ZAP": 210,
    "CP_2100ZAP": 2100
  }
};

// Validate config
const validateConfig = () => {
  const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "BLINK_API_KEY"];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) {
    console.error(`❌ Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
};
validateConfig();

// ============ SQLite Database ============
const dbPath = path.join(__dirname, "citadelpay.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS balances (
    user_id TEXT PRIMARY KEY,
    amount INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    type TEXT NOT NULL,
    from_uid TEXT,
    to_uid TEXT,
    amount INTEGER,
    fee INTEGER,
    balance_after INTEGER,
    details TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_uid);
  CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_uid);
  CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
  CREATE INDEX IF NOT EXISTS idx_tx_ts ON transactions(ts);

  CREATE TABLE IF NOT EXISTS pending_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    payment_request TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// ============ Migrate from JSON ============
const migrateFromJson = () => {
  const balanceFile = path.join(__dirname, "citadelpay_balances.json");
  if (!fs.existsSync(balanceFile)) return;

  const existing = db.prepare("SELECT COUNT(*) as cnt FROM balances").get();
  if (existing.cnt > 0) return;

  console.log("📦 Migrating JSON → SQLite...");

  const data = JSON.parse(fs.readFileSync(balanceFile, "utf8"));
  const insert = db.prepare("INSERT OR IGNORE INTO balances (user_id, amount) VALUES (?, ?)");

  const migrate = db.transaction(() => {
    let count = 0;
    for (const [uid, amt] of Object.entries(data)) {
      insert.run(uid, amt);
      count++;
    }
    console.log(`✅ Migrated ${count} balances`);
  });
  migrate();

  fs.renameSync(balanceFile, balanceFile + ".bak");
  console.log("📦 Old JSON files renamed to .bak");
};
migrateFromJson();

// ============ Rate Limiter ============
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.limits = new Map();
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(userId) {
    const now = Date.now();
    const userLimits = this.limits.get(userId) || [];
    const validRequests = userLimits.filter(ts => now - ts < this.windowMs);
    
    if (validRequests.length >= this.maxRequests) {
      const resetIn = Math.ceil((validRequests[0] + this.windowMs - now) / 1000);
      return { allowed: false, resetIn };
    }
    
    validRequests.push(now);
    this.limits.set(userId, validRequests);
    return { allowed: true };
  }
}

// Rate limiters for each command (500 users scale)
const depositLimiter = new RateLimiter(5, 60000);    // 5 per minute
const withdrawLimiter = new RateLimiter(3, 60000);   // 3 per minute
const tipLimiter = new RateLimiter(10, 60000);       // 10 per minute
const emojiTipLimiter = new RateLimiter(20, 60000);  // 20 per minute

// ============ DB Helpers (Prepared Statements) ============
const stmt = {
  getBalance: db.prepare("SELECT amount FROM balances WHERE user_id = ?"),
  upsertBalance: db.prepare("INSERT INTO balances (user_id, amount) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET amount = ?"),
  insertTx: db.prepare("INSERT INTO transactions (type, from_uid, to_uid, amount, fee, balance_after, details) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  insertPendingInvoice: db.prepare("INSERT INTO pending_invoices (user_id, payment_request, amount, created_at) VALUES (?, ?, ?, ?)"),
  deletePendingInvoice: db.prepare("DELETE FROM pending_invoices WHERE payment_request = ?"),
  getAllPendingInvoices: db.prepare("SELECT * FROM pending_invoices"),
};

// ============ Balance Operations (Atomic) ============
const balance = {
  get: (uid) => stmt.getBalance.get(uid)?.amount || 0,
  set: (uid, amt) => stmt.upsertBalance.run(uid, amt, amt),
  
  add: db.transaction((uid, amt) => {
    const cur = stmt.getBalance.get(uid)?.amount || 0;
    const newVal = cur + amt;
    stmt.upsertBalance.run(uid, newVal, newVal);
    return newVal;
  }),
  
  sub: db.transaction((uid, amt) => {
    const cur = stmt.getBalance.get(uid)?.amount || 0;
    if (cur < amt) {
      throw new Error(`Insufficient balance: ${cur} < ${amt}`);
    }
    const newVal = cur - amt;
    stmt.upsertBalance.run(uid, newVal, newVal);
    return newVal;
  }),
  
  transfer: db.transaction((fromUid, toUid, amt) => {
    const fromBal = stmt.getBalance.get(fromUid)?.amount || 0;
    if (fromBal < amt) {
      throw new Error(`Insufficient balance: ${fromBal} < ${amt}`);
    }
    const toBal = stmt.getBalance.get(toUid)?.amount || 0;
    stmt.upsertBalance.run(fromUid, fromBal - amt, fromBal - amt);
    stmt.upsertBalance.run(toUid, toBal + amt, toBal + amt);
    return { fromBalance: fromBal - amt, toBalance: toBal + amt };
  }),

  multiTransfer: db.transaction((fromUid, toUids, amt) => {
    const total = amt * toUids.length;
    const fromBal = stmt.getBalance.get(fromUid)?.amount || 0;
    if (fromBal < total) {
      throw new Error(`Insufficient balance: ${fromBal} < ${total}`);
    }
    stmt.upsertBalance.run(fromUid, fromBal - total, fromBal - total);
    for (const toUid of toUids) {
      const toBal = stmt.getBalance.get(toUid)?.amount || 0;
      stmt.upsertBalance.run(toUid, toBal + amt, toBal + amt);
    }
    return fromBal - total;
  })
};

const OWNER_ID = "owner";
const owner = {
  get: () => balance.get(OWNER_ID),
  add: (amt) => amt > 0 && balance.add(OWNER_ID, amt),
  reset: () => balance.set(OWNER_ID, 0)
};

// ============ Transaction Log ============
const txLog = (type, { from, to, uid, amount, fee, dest, status, reason, emoji, bal }) => {
  const fromUid = from || uid || null;
  const toUid = to || null;
  const balAfter = bal ?? null;
  const details = JSON.stringify(
    Object.fromEntries(Object.entries({ dest, status, reason, emoji }).filter(([, v]) => v != null))
  );
  stmt.insertTx.run(type, fromUid, toUid, amount || null, fee || null, balAfter, details === "{}" ? null : details);
};

// ============ Blink API ============
const blinkApi = axios.create({
  baseURL: config.blink.endpoint,
  headers: { "X-API-KEY": config.blink.apiKey, "Content-Type": "application/json" },
  timeout: 30000
});

const gql = async (query, variables = {}) => {
  const { data } = await blinkApi.post("", { query, variables });
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
};

let walletId = null;
const getWalletId = async () => {
  if (walletId) return walletId;
  const data = await gql(`{ me { defaultAccount { wallets { id walletCurrency } } } }`);
  const btc = data.me.defaultAccount.wallets.find(w => w.walletCurrency === "BTC");
  if (!btc) throw new Error("BTC wallet not found");
  walletId = btc.id;
  console.log("✅ Wallet:", walletId);
  return walletId;
};

const blink = {
  createInvoice: async (amount, memo) => {
    const data = await gql(
      `mutation($i: LnInvoiceCreateInput!) { lnInvoiceCreate(input: $i) { invoice { paymentRequest } errors { message } } }`,
      { i: { walletId: await getWalletId(), amount, memo } }
    );
    if (data.lnInvoiceCreate.errors?.length) throw new Error(data.lnInvoiceCreate.errors[0].message);
    return data.lnInvoiceCreate.invoice.paymentRequest;
  },

  checkInvoice: async (pr) => {
    const data = await gql(
      `query($i: LnInvoicePaymentStatusByPaymentRequestInput!) { lnInvoicePaymentStatusByPaymentRequest(input: $i) { status } }`,
      { i: { paymentRequest: pr } }
    );
    return data.lnInvoicePaymentStatusByPaymentRequest?.status;
  },

  probeFee: async (pr) => {
    try {
      const data = await gql(
        `mutation($i: LnInvoiceFeeProbeInput!) { lnInvoiceFeeProbe(input: $i) { amount } }`,
        { i: { walletId: await getWalletId(), paymentRequest: pr } }
      );
      return data.lnInvoiceFeeProbe.amount || 0;
    } catch { return null; }
  },

  pay: async (pr) => {
    const data = await gql(
      `mutation($i: LnInvoicePaymentInput!) { lnInvoicePaymentSend(input: $i) { status errors { message } } }`,
      { i: { walletId: await getWalletId(), paymentRequest: pr } }
    );
    if (data.lnInvoicePaymentSend.errors?.length) throw new Error(data.lnInvoicePaymentSend.errors[0].message);
    return data.lnInvoicePaymentSend.status;
  },

  payZeroAmount: async (pr, amount) => {
    const data = await gql(
      `mutation($i: LnNoAmountInvoicePaymentInput!) { lnNoAmountInvoicePaymentSend(input: $i) { status errors { message } } }`,
      { i: { walletId: await getWalletId(), paymentRequest: pr, amount } }
    );
    if (data.lnNoAmountInvoicePaymentSend.errors?.length) throw new Error(data.lnNoAmountInvoicePaymentSend.errors[0].message);
    return data.lnNoAmountInvoicePaymentSend.status;
  },

  verifyOutgoingPayment: async (paymentRequest) => {
    try {
      const decoded = bolt11.decode(paymentRequest);
      const targetHash = decoded.sections?.find(s => s.name === "payment_hash")?.value;
      if (!targetHash) return null;

      await sleep(3000);
      const data = await gql(`
        query {
          me {
            defaultAccount {
              transactions(first: 10) {
                edges {
                  node {
                    direction
                    status
                    initiationVia {
                      ... on InitiationViaLn {
                        paymentHash
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `);

      const txs = data.me.defaultAccount.transactions.edges;
      for (const { node } of txs) {
        if (node.direction === "SEND" && node.initiationVia?.paymentHash === targetHash) {
          return node.status;
        }
      }
      return "NOT_FOUND";
    } catch (e) {
      console.error("Payment verification failed:", e.message);
      return null;
    }
  }
};

// ============ Utils ============
const sleep = ms => new Promise(r => setTimeout(r, ms));

const decodeInvoiceAmount = (invoice) => {
  try {
    const d = bolt11.decode(invoice);
    if (d.satoshis) return parseInt(d.satoshis);
    if (d.millisatoshis) return Math.floor(parseInt(d.millisatoshis) / 1000);
    const amt = d.sections?.find(s => s.name === "amount")?.value;
    return amt ? Math.floor(parseInt(amt) / 1000) : null;
  } catch { return null; }
};

const validateUrl = (urlStr) => {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== "https:") throw new Error("HTTPS only");
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1") throw new Error("Blocked host");
  if (hostname.endsWith(".local")) throw new Error("Blocked domain");
  const parts = hostname.split(".").map(Number);
  if (parts[0] === 10) throw new Error("Blocked IP");
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) throw new Error("Blocked IP");
  if (parts[0] === 192 && parts[1] === 168) throw new Error("Blocked IP");
  if (parts[0] === 169 && parts[1] === 254) throw new Error("Blocked IP");
  return urlStr;
};

const getLnurlInvoice = async (addr, sats) => {
  const [user, domain] = addr.split("@");
  if (!user || !domain) throw new Error("Invalid address");
  const wellKnownUrl = validateUrl(`https://${domain}/.well-known/lnurlp/${user}`);
  const { data: lnurl } = await axios.get(wellKnownUrl, { timeout: 10000, maxRedirects: 3, beforeRedirect: (opts) => validateUrl(opts.href) });
  if (lnurl.status === "ERROR") throw new Error(lnurl.reason);
  const callbackUrl = validateUrl(lnurl.callback);
  const { data: inv } = await axios.get(callbackUrl, { params: { amount: sats * 1000 }, timeout: 10000, maxRedirects: 3, beforeRedirect: (opts) => validateUrl(opts.href) });
  if (inv.status === "ERROR") throw new Error(inv.reason);
  return inv.pr;
};

const watchInvoice = async (pr, uid, amount, createdAt = Date.now()) => {
  const elapsed = Date.now() - createdAt;
  const remaining = config.limits.invoiceExpiry - elapsed;
  if (remaining <= 0) {
    stmt.deletePendingInvoice.run(pr);
    return;
  }
  const start = Date.now();
  while (Date.now() - start < remaining) {
    try {
      const status = await blink.checkInvoice(pr);
      if (status === "PAID") {
        balance.add(uid, amount);
        txLog("deposit", { uid, amount, bal: balance.get(uid) });
        stmt.deletePendingInvoice.run(pr);
        console.log(`✅ +${amount} sats → ${uid}`);
        return;
      }
      if (status === "EXPIRED" || status === "CANCELLED") {
        stmt.deletePendingInvoice.run(pr);
        return;
      }
    } catch (e) { console.error("Poll error:", e.message); }
    await sleep(config.limits.pollInterval);
  }
  stmt.deletePendingInvoice.run(pr);
};

const restorePendingInvoices = () => {
  const pending = stmt.getAllPendingInvoices.all();
  if (!pending.length) return;
  console.log(`🔄 Restoring ${pending.length} pending invoice(s)...`);
  for (const row of pending) {
    watchInvoice(row.payment_request, row.user_id, row.amount, row.created_at).catch(console.error);
    console.log(`🔄 Invoice restored: ${row.user_id} ${row.amount} sats`);
  }
};

// ============ Discord Client ============
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Reaction]
});

// ============ Commands ============
const commands = [
  new SlashCommandBuilder().setName("deposit").setDescription("Create deposit invoice")
    .setDescriptionLocalizations({ ko: "입금 인보이스 생성", ja: "入金インボイス作成", "es-ES": "Crear factura de depósito" })
    .addIntegerOption(o => o.setName("amount").setDescription("Amount (sats)").setDescriptionLocalizations({ ko: "금액 (sats)", ja: "金額 (sats)", "es-ES": "Cantidad (sats)" }).setRequired(true)),

  new SlashCommandBuilder().setName("balance").setDescription("Check balance")
    .setDescriptionLocalizations({ ko: "잔액 확인", ja: "残高確認", "es-ES": "Ver saldo" }),

  new SlashCommandBuilder().setName("tip").setDescription("Send sats")
    .setDescriptionLocalizations({ ko: "sats 보내기", ja: "sats送金", "es-ES": "Enviar sats" })
    .addStringOption(o => o.setName("users").setDescription("Recipients (@user1 @user2 ...)").setDescriptionLocalizations({ ko: "받는 사람 (@유저1 @유저2 ...)", ja: "受取人 (@user1 @user2 ...)", "es-ES": "Destinatarios (@user1 @user2 ...)" }).setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount per person (sats)").setDescriptionLocalizations({ ko: "1인당 금액 (sats)", ja: "1人当たりの金額 (sats)", "es-ES": "Cantidad por persona (sats)" }).setRequired(true))
    .addStringOption(o => o.setName("message").setDescription("Message").setDescriptionLocalizations({ ko: "메시지", ja: "メッセージ", "es-ES": "Mensaje" }).setRequired(false)),

  new SlashCommandBuilder().setName("withdraw").setDescription("Withdraw sats")
    .setDescriptionLocalizations({ ko: "출금", ja: "出金", "es-ES": "Retirar" }),

  new SlashCommandBuilder().setName("owner_balance").setDescription("Owner balance")
    .setDescriptionLocalizations({ ko: "운영자 잔액", ja: "オーナー残高", "es-ES": "Saldo del propietario" }),

  new SlashCommandBuilder().setName("owner_withdraw").setDescription("Owner withdraw")
    .setDescriptionLocalizations({ ko: "운영자 출금", ja: "オーナー出金", "es-ES": "Retiro del propietario" })
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true)),

  new SlashCommandBuilder().setName("owner_reset").setDescription("Reset owner balance")
    .setDescriptionLocalizations({ ko: "운영자 잔액 초기화", ja: "オーナー残高リセット", "es-ES": "Restablecer saldo" })
];

const registerCommands = async () => {
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), { body: commands.map(c => c.toJSON()) });
  console.log("✅ Commands registered");
};

// ============ Emoji Tips ============
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    console.log(`[DEBUG] emoji: name="${reaction.emoji.name}" id=${reaction.emoji.id}`);
    const amount = config.emojiTips[reaction.emoji.name];
    if (!amount) return;

    const emojiCheck = emojiTipLimiter.check(user.id);
    if (!emojiCheck.allowed) {
      try {
        await user.send(`⏰ 이모지 팁 제한: ${emojiCheck.resetIn}초 후 다시 시도하세요.`);
      } catch {}
      return;
    }

    const author = reaction.message.author;
    if (author.id === user.id || author.bot) return;

    if (balance.get(user.id) < amount) {
      try {
        await reaction.users.remove(user.id);
        await user.send(`❌ Balance: ${balance.get(user.id)} sats (Need: ${amount})`);
      } catch {}
      return;
    }

    balance.transfer(user.id, author.id, amount);
    txLog("emoji_tip", { from: user.id, to: author.id, amount, emoji: reaction.emoji.name });

    await reaction.message.channel.send(`⚡ <@${user.id}> ➡️ <@${author.id}> **${amount} sats** tip!`);

    try {
      await author.send(`⚡ <@${user.id}> ➡️ You **${amount} sats**\n📍 <#${reaction.message.channelId}>\n💰 Balance: **${balance.get(author.id)} sats**`);
    } catch {}

    console.log(`⚡ ${user.id} → ${author.id}: ${amount} sats`);
  } catch (e) { console.error("Reaction error:", e); }
});

// ============ Interactions ============
client.on("interactionCreate", async (i) => {
  try {
    // Buttons
    if (i.isButton()) {
      if (i.customId === "withdraw_lightning_address") {
        const modal = new ModalBuilder().setCustomId("withdraw_addr").setTitle("⚡ Lightning Address");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("addr").setLabel("Address").setStyle(TextInputStyle.Short).setPlaceholder("user@wallet.com").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amt").setLabel("Amount (sats)").setStyle(TextInputStyle.Short).setRequired(true))
        );
        return i.showModal(modal);
      }

      if (i.customId === "withdraw_invoice") {
        const modal = new ModalBuilder().setCustomId("withdraw_inv").setTitle("🧾 Invoice");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("inv").setLabel("Invoice / LNURL").setStyle(TextInputStyle.Paragraph).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amt").setLabel("Amount (zero-amt only)").setStyle(TextInputStyle.Short).setRequired(false))
        );
        return i.showModal(modal);
      }
      return;
    }

    // Modals
    if (i.isModalSubmit()) {
      if (i.customId === "withdraw_addr") {
        await i.deferReply({ ephemeral: true });
        const addr = i.fields.getTextInputValue("addr").trim();
        const amt = parseInt(i.fields.getTextInputValue("amt"));

        if (!amt || amt <= 0) return i.editReply("❌ Invalid amount");
        if (amt > config.limits.maxWithdraw) return i.editReply(`❌ Max: ${config.limits.maxWithdraw} sats`);

        try {
          const inv = await getLnurlInvoice(addr, amt);
          const blinkFee = await blink.probeFee(inv);
          const fee = blinkFee === 0 ? config.fees.internal : config.fees.external;
          const total = amt + fee;

          if (balance.get(i.user.id) < total) return i.editReply(`❌ Balance: ${balance.get(i.user.id)} (Need: ${total})`);

          balance.sub(i.user.id, total);
          if (fee > 0) owner.add(fee);
          txLog("withdraw", { uid: i.user.id, amount: amt, fee, dest: addr, status: "pending" });

          try {
            await blink.pay(inv);
            txLog("withdraw", { uid: i.user.id, amount: amt, dest: addr, status: "success" });
          } catch (payErr) {
            console.error(`⚠️ Withdraw error (${i.user.id}): ${amt} sats → ${addr} - ${payErr.message}`);
            const status = await blink.verifyOutgoingPayment(inv);
            if (status === "NOT_FOUND") {
              balance.add(i.user.id, total);
              if (fee > 0) owner.add(-fee);
              txLog("withdraw", { uid: i.user.id, amount: amt, dest: addr, status: "refunded", reason: payErr.message });
              throw payErr;
            } else if (status === "SUCCESS" || status === "PENDING") {
              txLog("withdraw", { uid: i.user.id, amount: amt, dest: addr, status: "verified_" + status, reason: payErr.message });
              console.log(`✅ Verified: payment ${status} despite error (${i.user.id})`);
              return i.editReply(`⚠️ **에러 발생했지만 결제 확인됨**\n📤 ${amt} sats ➡️ \`${addr}\`\n💰 Balance: **${balance.get(i.user.id)} sats**`);
            } else {
              txLog("withdraw", { uid: i.user.id, amount: amt, dest: addr, status: "unverified", reason: payErr.message });
              console.error(`⚠️ Cannot verify payment (${i.user.id}) - keeping deduction`);
              return i.editReply(`⚠️ **에러 발생 - 결제 확인 불가**\n잔액이 차감되었으며, 미처리시 관리자에게 문의하세요.\n💰 Balance: **${balance.get(i.user.id)} sats**`);
            }
          }

          await i.editReply(`✅ **Sent!**\n📤 ${amt} sats ➡️ \`${addr}\`\n💸 Fee: ${fee || "Free"}\n💰 Balance: **${balance.get(i.user.id)} sats**`);
        } catch (e) { await i.editReply(`❌ ${e.message}`); }
        return;
      }

      if (i.customId === "withdraw_inv") {
        await i.deferReply({ ephemeral: true });
        const inv = i.fields.getTextInputValue("inv").trim();
        const amtInput = i.fields.getTextInputValue("amt").trim();
        const amtOpt = amtInput ? parseInt(amtInput) : null;

        const invAmt = decodeInvoiceAmount(inv);
        const amt = amtOpt || invAmt;

        if (!amt || amt <= 0) return i.editReply("❌ Invalid amount");
        if (amt > config.limits.maxWithdraw) return i.editReply(`❌ Max: ${config.limits.maxWithdraw} sats`);

        try {
          const blinkFee = await blink.probeFee(inv);
          const fee = blinkFee === 0 ? config.fees.internal : config.fees.external;
          const total = amt + fee;

          if (balance.get(i.user.id) < total) return i.editReply(`❌ Balance: ${balance.get(i.user.id)} (Need: ${total})`);

          balance.sub(i.user.id, total);
          if (fee > 0) owner.add(fee);
          txLog("withdraw", { uid: i.user.id, amount: amt, fee, dest: "invoice", status: "pending" });

          try {
            if (amtOpt && !invAmt) {
              await blink.payZeroAmount(inv, amt);
            } else {
              await blink.pay(inv);
            }
            txLog("withdraw", { uid: i.user.id, amount: amt, dest: "invoice", status: "success" });
          } catch (payErr) {
            console.error(`⚠️ Withdraw error (${i.user.id}): ${amt} sats invoice - ${payErr.message}`);
            const status = await blink.verifyOutgoingPayment(inv);
            if (status === "NOT_FOUND") {
              balance.add(i.user.id, total);
              if (fee > 0) owner.add(-fee);
              txLog("withdraw", { uid: i.user.id, amount: amt, dest: "invoice", status: "refunded", reason: payErr.message });
              throw payErr;
            } else if (status === "SUCCESS" || status === "PENDING") {
              txLog("withdraw", { uid: i.user.id, amount: amt, dest: "invoice", status: "verified_" + status, reason: payErr.message });
              console.log(`✅ Verified: payment ${status} despite error (${i.user.id})`);
              return i.editReply(`⚠️ **에러 발생했지만 결제 확인됨**\n📤 ${amt} sats\n💰 Balance: **${balance.get(i.user.id)} sats**`);
            } else {
              txLog("withdraw", { uid: i.user.id, amount: amt, dest: "invoice", status: "unverified", reason: payErr.message });
              console.error(`⚠️ Cannot verify payment (${i.user.id}) - keeping deduction`);
              return i.editReply(`⚠️ **에러 발생 - 결제 확인 불가**\n잔액이 차감되었으며, 미처리시 관리자에게 문의하세요.\n💰 Balance: **${balance.get(i.user.id)} sats**`);
            }
          }

          await i.editReply(`✅ **Sent!**\n📤 ${amt} sats\n💸 Fee: ${fee || "Free"}\n💰 Balance: **${balance.get(i.user.id)} sats**`);
        } catch (e) { await i.editReply(`❌ ${e.message}`); }
        return;
      }
      return;
    }

    // Commands
    if (!i.isChatInputCommand()) return;
    const uid = i.user.id;

    switch (i.commandName) {
      case "balance":
        return i.reply({ content: `💰 Balance: **${balance.get(uid)} sats**`, ephemeral: true });

      case "deposit": {
        const depositCheck = depositLimiter.check(uid);
        if (!depositCheck.allowed) {
          return i.reply({ content: `⏰ 너무 많은 요청입니다. ${depositCheck.resetIn}초 후 다시 시도하세요.`, ephemeral: true });
        }

        const amt = i.options.getInteger("amount");
        if (amt <= 0) return i.reply({ content: "❌ Amount > 0", ephemeral: true });

        await i.deferReply({ ephemeral: true });
        try {
          const pr = await blink.createInvoice(amt, `CitadelPay-${uid}`);
          const qr = await qrcode.toBuffer(pr);
          const now = Date.now();
          stmt.insertPendingInvoice.run(uid, pr, amt, now);
          watchInvoice(pr, uid, amt, now).catch(console.error);

          await i.editReply({ content: `🧾 **Deposit**\n💰 **${amt} sats**\n📱 Scan or copy:`, files: [new AttachmentBuilder(qr, { name: "qr.png" })] });
          await i.followUp({ content: pr, ephemeral: true });
        } catch (e) { await i.editReply(`❌ ${e.message}`); }
        return;
      }

      case "tip": {
        const tipCheck = tipLimiter.check(uid);
        if (!tipCheck.allowed) {
          return i.reply({ content: `⏰ 너무 많은 요청입니다. ${tipCheck.resetIn}초 후 다시 시도하세요.`, ephemeral: true });
        }

        const usersInput = i.options.getString("users");
        const amt = i.options.getInteger("amount");
        const msg = i.options.getString("message");

        if (amt <= 0) return i.reply({ content: "❌ Amount > 0", ephemeral: true });

        const userIds = [...new Set(usersInput.match(/<@!?(\d+)>/g)?.map(m => m.replace(/<@!?|>/g, "")) || [])];
        if (!userIds.length) return i.reply({ content: "❌ @멘션으로 유저를 지정하세요", ephemeral: true });

        const targets = userIds.filter(id => id !== uid);
        if (!targets.length) return i.reply({ content: "❌ 자신에게는 팁을 보낼 수 없습니다", ephemeral: true });

        // users.fetch 루프 전에 defer → 인터랙션 토큰 15분으로 연장
        await i.deferReply();

        const resolved = [];
        for (const id of targets) {
          try {
            const u = await client.users.fetch(id);
            if (u.bot) continue;
            resolved.push(u);
          } catch {}
        }
        if (!resolved.length) return i.editReply("❌ 유효한 유저가 없습니다");

        const finalTotal = amt * resolved.length;
        if (balance.get(uid) < finalTotal) return i.editReply(`❌ Balance: ${balance.get(uid)} sats (Need: ${finalTotal})`);

        balance.multiTransfer(uid, resolved.map(u => u.id), amt);
        for (const u of resolved) {
          txLog("tip", { from: uid, to: u.id, amount: amt });
          try { await u.send(`💰 <@${uid}> ➡️ You **${amt} sats**\n📍 <#${i.channelId}>\n💰 Balance: **${balance.get(u.id)} sats**`); } catch {}
        }

        const mentions = resolved.map(u => `<@${u.id}>`).join(", ");
        let reply = `⚡ <@${uid}> ➡️ ${mentions} **${amt} sats** each! (Total: **${finalTotal} sats**)`;
        if (msg) reply += `\n💬 ${msg}`;
        await i.editReply({ content: reply });
        return;
      }

      case "withdraw": {
        const withdrawCheck = withdrawLimiter.check(uid);
        if (!withdrawCheck.allowed) {
          return i.reply({ content: `⏰ 너무 많은 요청입니다. ${withdrawCheck.resetIn}초 후 다시 시도하세요.`, ephemeral: true });
        }

        const embed = new EmbedBuilder().setColor(0xF7931A).setTitle("💰 Withdraw")
          .setDescription(`⚡ **Lightning Address**: user@wallet.com\n🧾 **Invoice/LNURL**: lnbc...\n\n💸 Fee: Blink=Free, Other=${config.fees.external} sats\n📊 Max: ${config.limits.maxWithdraw} sats`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("withdraw_lightning_address").setLabel("⚡ Address").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("withdraw_invoice").setLabel("🧾 Invoice").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true });
      }

      case "owner_balance":
        if (uid !== config.discord.ownerId) return i.reply({ content: "❌ Owner only", ephemeral: true });
        return i.reply({ content: `💼 Owner: **${owner.get()} sats**`, ephemeral: true });

      case "owner_withdraw": {
        if (uid !== config.discord.ownerId) return i.reply({ content: "❌ Owner only", ephemeral: true });
        const amt = i.options.getInteger("amount");
        if (amt <= 0) return i.reply({ content: "❌ Amount > 0", ephemeral: true });
        if (owner.get() < amt) return i.reply({ content: `❌ Owner: ${owner.get()} sats`, ephemeral: true });

        balance.sub(OWNER_ID, amt);
        balance.add(uid, amt);
        txLog("owner_withdraw", { uid, amount: amt });
        return i.reply({ content: `✅ Owner ➡️ You **${amt} sats**`, ephemeral: true });
      }

      case "owner_reset":
        if (uid !== config.discord.ownerId) return i.reply({ content: "❌ Owner only", ephemeral: true });
        owner.reset();
        return i.reply({ content: "✅ Owner = 0", ephemeral: true });
    }
  } catch (e) {
    console.error("Interaction error:", e);
    if (!i.replied && !i.deferred) {
      try { await i.reply({ content: "❌ Error", ephemeral: true }); } catch {}
    }
  }
});

// ============ Graceful Shutdown ============
const shutdown = () => {
  console.log("🔄 Shutting down...");
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ============ Start ============
client.once("ready", async () => {
  console.log(`🤖 ${client.user.tag}`);
  await registerCommands();
  restorePendingInvoices();
  console.log("✅ Ready (SQLite)");
});

client.login(config.discord.token);
