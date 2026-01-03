# ⚡ CitadelPay

Discord Lightning Payment Bot using Blink API

## Features

- 💰 **Deposit/Withdraw** - Lightning invoices & LNURL
- 💸 **Tip** - Send sats to users
- 🎁 **Redpacket** - 60min expiry with auto-refund
- ⚡ **Emoji Tip** - React to tip (⚡, 1ZAP, 21ZAP, 210ZAP, 2100ZAP)
- 🌍 **i18n** - EN/KO/JA/ES
- 🔄 **Smart Fees** - Blink internal = free

## Quick Start

```bash
git clone https://github.com/yourusername/citadelpay.git
cd citadelpay
npm install
cp .env.example .env
nano .env  # Fill credentials
npm start
```

## PM2

```bash
pm2 start bot.js --name citadelpay
pm2 save
pm2 startup
```

## Commands

| Command | Description |
|---------|-------------|
| `/deposit <amount>` | Create invoice |
| `/balance` | Check balance |
| `/tip <user> <amount>` | Send sats |
| `/withdraw` | Withdraw to Lightning |
| `/redpacket <amount> <count>` | Create redpacket |

## Emoji Tips

| Emoji | Sats |
|-------|------|
| ⚡ | 21 |
| :1ZAP: | 1 |
| :21ZAP: | 21 |
| :210ZAP: | 210 |
| :2100ZAP: | 2100 |

## License

MIT
