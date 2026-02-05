/**
 * CitadelPay v16 - Discord Lightning Payment Bot
 * 
 * Features:
 * - Deposit/Withdraw via Lightning
 * - Tip users with sats
 * - Redpacket with 60min expiry
 * - Emoji reactions for tipping
 * - Multi-language support (EN/KO/JA/ES)
 * - Smart fees (Blink internal = free)
 */

require("dotenv").config();
const fs = require("fs");
const axios = require("axios");
const qrcode = require("qrcode");
const bolt11 = require("light-bolt11-decoder");

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
    maxRedpacketCount: 100,
    redpacketExpiry: 60 * 60 * 1000, // 60 min
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

// ============ Storage ============
class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
  del(k) { delete this.data[k]; this.save(); }
  all() { return this.data; }
}

const balanceStore = new JsonStore("./citadelpay_balances.json");
const redpacketStore = new JsonStore("./citadelpay_redpackets.json");

const balance = {
  get: (uid) => balanceStore.get(uid) || 0,
  set: (uid, amt) => balanceStore.set(uid, amt),
  add: (uid, amt) => balanceStore.set(uid, balance.get(uid) + amt),
  sub: (uid, amt) => balanceStore.set(uid, Math.max(0, balance.get(uid) - amt))
};

const OWNER_ID = "owner";
const owner = {
  get: () => balance.get(OWNER_ID),
  add: (amt) => amt > 0 && balance.add(OWNER_ID, amt),
  reset: () => balance.set(OWNER_ID, 0)
};

// ============ Transaction Log ============
const txLog = (type, data) => {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
  fs.appendFileSync("./citadelpay_tx.log", entry + "\n");
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

const getLnurlInvoice = async (addr, sats) => {
  const [user, domain] = addr.split("@");
  if (!user || !domain) throw new Error("Invalid address");
  const { data: lnurl } = await axios.get(`https://${domain}/.well-known/lnurlp/${user}`, { timeout: 10000 });
  if (lnurl.status === "ERROR") throw new Error(lnurl.reason);
  const { data: inv } = await axios.get(lnurl.callback, { params: { amount: sats * 1000 }, timeout: 10000 });
  if (inv.status === "ERROR") throw new Error(inv.reason);
  return inv.pr;
};

const watchInvoice = async (pr, uid, amount) => {
  const start = Date.now();
  while (Date.now() - start < config.limits.invoiceExpiry) {
    try {
      const status = await blink.checkInvoice(pr);
      if (status === "PAID") {
        balance.add(uid, amount);
        txLog("deposit", { uid, amount, bal: balance.get(uid) });
        console.log(`✅ +${amount} sats → ${uid}`);
        return;
      }
      if (status === "EXPIRED" || status === "CANCELLED") return;
    } catch (e) { console.error("Poll error:", e.message); }
    await sleep(config.limits.pollInterval);
  }
};

// ============ Discord Client ============
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Reaction]
});

// ============ Redpacket ============
const expireRedpacket = async (msgId, channelId) => {
  const pkt = redpacketStore.get(msgId);
  if (!pkt || pkt.expired) return;

  pkt.expired = true;
  redpacketStore.set(msgId, pkt);

  const claimed = pkt.claimedBy?.length || 0;
  const refund = (pkt.count - claimed) * pkt.per;

  if (refund > 0) {
    balance.add(pkt.creatorId, refund);
    txLog("redpacket_refund", { uid: pkt.creatorId, amount: refund, bal: balance.get(pkt.creatorId) });
    try {
      const user = await client.users.fetch(pkt.creatorId);
      await user.send(`🎁 **Expired!**\n👥 ${claimed}/${pkt.count}\n💸 Refund: **${refund} sats**\n💰 Balance: **${balance.get(pkt.creatorId)} sats**`);
    } catch {}
  }

  try {
    const ch = await client.channels.fetch(channelId);
    const msg = await ch.messages.fetch(msgId);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("expired").setLabel("⏰ Expired").setStyle(ButtonStyle.Secondary).setDisabled(true)
    );
    await msg.edit({ content: msg.content + "\n\n⏰ **Expired**", components: [row] });
  } catch {}

  console.log(`⏰ Redpacket ${msgId}: refund ${refund} sats`);
};

const restoreTimers = () => {
  const now = Date.now();
  for (const [id, pkt] of Object.entries(redpacketStore.all())) {
    if (pkt.expired || !pkt.createdAt || !pkt.channelId) continue;
    if ((pkt.claimedBy?.length || 0) >= pkt.count) continue;

    const remaining = config.limits.redpacketExpiry - (now - pkt.createdAt);
    if (remaining <= 0) {
      expireRedpacket(id, pkt.channelId);
    } else {
      setTimeout(() => expireRedpacket(id, pkt.channelId), remaining);
      console.log(`🔄 Timer: ${id} (${Math.round(remaining/1000)}s)`);
    }
  }
};

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

  new SlashCommandBuilder().setName("redpacket").setDescription("Create redpacket")
    .setDescriptionLocalizations({ ko: "레드패킷 생성", ja: "レッドパケット作成", "es-ES": "Crear paquete rojo" })
    .addIntegerOption(o => o.setName("amount").setDescription("Per person (sats)").setDescriptionLocalizations({ ko: "1인당 (sats)", ja: "1人当たり (sats)", "es-ES": "Por persona (sats)" }).setRequired(true))
    .addIntegerOption(o => o.setName("count").setDescription("Count").setDescriptionLocalizations({ ko: "인원", ja: "人数", "es-ES": "Cantidad" }).setRequired(true))
    .addStringOption(o => o.setName("memo").setDescription("Memo").setDescriptionLocalizations({ ko: "메모", ja: "メモ", "es-ES": "Nota" }).setRequired(false)),

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

    const author = reaction.message.author;
    if (author.id === user.id || author.bot) return;

    if (balance.get(user.id) < amount) {
      try {
        await reaction.users.remove(user.id);
        await user.send(`❌ Balance: ${balance.get(user.id)} sats (Need: ${amount})`);
      } catch {}
      return;
    }

    balance.sub(user.id, amount);
    balance.add(author.id, amount);
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
      if (i.customId === "redpacket_claim") {
        const pkt = redpacketStore.get(i.message.id);
        if (!pkt) return i.reply({ content: "❌ Invalid", ephemeral: true });
        if (pkt.expired) return i.reply({ content: "❌ Expired", ephemeral: true });
        if (pkt.creatorId === i.user.id) return i.reply({ content: "❌ Own packet", ephemeral: true });
        if (pkt.claimedBy?.includes(i.user.id)) return i.reply({ content: "❌ Already claimed", ephemeral: true });
        if ((pkt.claimedBy?.length || 0) >= pkt.count) return i.reply({ content: "❌ All claimed", ephemeral: true });

        balance.add(i.user.id, pkt.per);
        txLog("redpacket_claim", { uid: i.user.id, amount: pkt.per, from: pkt.creatorId, bal: balance.get(i.user.id) });
        pkt.claimedBy = [...(pkt.claimedBy || []), i.user.id];
        redpacketStore.set(i.message.id, pkt);

        await i.reply({ content: `🎉 <@${i.user.id}> +**${pkt.per} sats**!` });

        if (pkt.claimedBy.length >= pkt.count) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("done").setLabel("✅ Done").setStyle(ButtonStyle.Secondary).setDisabled(true)
          );
          await i.message.edit({ components: [row] });
        }
        return;
      }

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

          // 잔액 먼저 차감 (이중지불 방지)
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

          // 잔액 먼저 차감 (이중지불 방지)
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
        const amt = i.options.getInteger("amount");
        if (amt <= 0) return i.reply({ content: "❌ Amount > 0", ephemeral: true });

        await i.deferReply({ ephemeral: true });
        try {
          const pr = await blink.createInvoice(amt, `CitadelPay-${uid}`);
          const qr = await qrcode.toBuffer(pr);
          watchInvoice(pr, uid, amt).catch(console.error);

          await i.editReply({ content: `🧾 **Deposit**\n💰 **${amt} sats**\n📱 Scan or copy:`, files: [new AttachmentBuilder(qr, { name: "qr.png" })] });
          await i.followUp({ content: pr, ephemeral: true });
        } catch (e) { await i.editReply(`❌ ${e.message}`); }
        return;
      }

      case "tip": {
        const usersInput = i.options.getString("users");
        const amt = i.options.getInteger("amount");
        const msg = i.options.getString("message");

        if (amt <= 0) return i.reply({ content: "❌ Amount > 0", ephemeral: true });

        // 멘션에서 유저 ID 추출
        const userIds = [...new Set(usersInput.match(/<@!?(\d+)>/g)?.map(m => m.replace(/<@!?|>/g, "")) || [])];
        if (!userIds.length) return i.reply({ content: "❌ @멘션으로 유저를 지정하세요", ephemeral: true });

        // 자기 자신 제외
        const targets = userIds.filter(id => id !== uid);
        if (!targets.length) return i.reply({ content: "❌ 자신에게는 팁을 보낼 수 없습니다", ephemeral: true });

        const total = amt * targets.length;
        if (balance.get(uid) < total) return i.reply({ content: `❌ Balance: ${balance.get(uid)} sats (Need: ${total})`, ephemeral: true });

        // 봇 체크
        const resolved = [];
        for (const id of targets) {
          try {
            const u = await client.users.fetch(id);
            if (u.bot) continue;
            resolved.push(u);
          } catch {}
        }
        if (!resolved.length) return i.reply({ content: "❌ 유효한 유저가 없습니다", ephemeral: true });

        const finalTotal = amt * resolved.length;
        if (balance.get(uid) < finalTotal) return i.reply({ content: `❌ Balance: ${balance.get(uid)} sats (Need: ${finalTotal})`, ephemeral: true });

        balance.sub(uid, finalTotal);
        for (const u of resolved) {
          balance.add(u.id, amt);
          txLog("tip", { from: uid, to: u.id, amount: amt });
          try { await u.send(`💰 <@${uid}> ➡️ You **${amt} sats**\n📍 <#${i.channelId}>\n💰 Balance: **${balance.get(u.id)} sats**`); } catch {}
        }

        const mentions = resolved.map(u => `<@${u.id}>`).join(", ");
        let reply = `⚡ <@${uid}> ➡️ ${mentions} **${amt} sats** each! (Total: **${finalTotal} sats**)`;
        if (msg) reply += `\n💬 ${msg}`;
        await i.reply({ content: reply });
        return;
      }

      case "withdraw": {
        const embed = new EmbedBuilder().setColor(0xF7931A).setTitle("💰 Withdraw")
          .setDescription(`⚡ **Lightning Address**: user@wallet.com\n🧾 **Invoice/LNURL**: lnbc...\n\n💸 Fee: Blink=Free, Other=${config.fees.external} sats\n📊 Max: ${config.limits.maxWithdraw} sats`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("withdraw_lightning_address").setLabel("⚡ Address").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("withdraw_invoice").setLabel("🧾 Invoice").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true });
      }

      case "redpacket": {
        const per = i.options.getInteger("amount");
        const count = i.options.getInteger("count");
        const memo = i.options.getString("memo");

        if (per <= 0 || count <= 0) return i.reply({ content: "❌ Amount & count > 0", ephemeral: true });
        if (count > config.limits.maxRedpacketCount) return i.reply({ content: `❌ Max: ${config.limits.maxRedpacketCount}`, ephemeral: true });

        const total = per * count;
        if (balance.get(uid) < total) return i.reply({ content: `❌ Balance: ${balance.get(uid)} (Need: ${total})`, ephemeral: true });

        balance.sub(uid, total);
        txLog("redpacket_create", { uid, amount: total, per, count });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("redpacket_claim").setLabel("🎁 CLAIM").setStyle(ButtonStyle.Primary)
        );

        let content = `🎁 **Redpacket**\n💰 ${per} × ${count} = **${total} sats**\n⏰ 60 min`;
        if (memo) content += `\n💬 ${memo}`;

        const msg = await i.reply({ content, components: [row], fetchReply: true });

        redpacketStore.set(msg.id, {
          creatorId: uid, amount: total, count, per,
          claimedBy: [], channelId: i.channelId,
          createdAt: Date.now(), expired: false, memo
        });

        setTimeout(() => expireRedpacket(msg.id, i.channelId), config.limits.redpacketExpiry);
        return;
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

// ============ Start ============
client.once("ready", async () => {
  console.log(`🤖 ${client.user.tag}`);
  await registerCommands();
  restoreTimers();
  console.log("✅ Ready");
});

client.login(config.discord.token);
