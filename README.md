# FriendCoin 🪙

Your own cryptocurrency — for your own people.

This repository contains the **desktop client**: wallets, signed transfers, mining, local validation and standalone builds. The server implementation and its deployment files are maintained separately.

Version `2.0.0-rc.2` restores the original wallet menu: **↑ / ↓ and Enter** in an interactive terminal. The protocol 2 network is a migration candidate; the existing protocol 1 server has not been upgraded.

## Download a client

Download the file for your desktop OS from [GitHub Releases](https://github.com/escanderm/friends_coin/releases):

- `friendcoin-macos-arm64` — Apple Silicon
- `friendcoin-macos-x64` — Intel Mac
- `friendcoin-linux-x64`
- `friendcoin-windows-x64.exe`

The Node.js runtime is included. Check the download against `SHA256SUMS`. Mobile clients are outside this project.

## Wallet selection

Use the arrow keys and Enter to select an existing wallet, create a new user, load a wallet from an external drive, or exit.

“Загрузить кошелёк с флешки/диска” accepts a **file or folder**. Relative paths such as `../../` and `../wallets` work as before. A folder opens a wallet list with the same arrow controls. For the standalone executable, relative paths start beside the executable; source launches use the current directory.

The last successfully opened wallet is remembered and shown first on the next launch. Its password is still required. Only the file path is saved in local `friendcoin.ui.json`; no password or private key is saved there.

New wallets are encrypted `.fcwallet` files. Selecting an old `wallet_<name>.json` explicitly imports it into a separate encrypted file; the original remains unchanged. Back up the encrypted file and its password separately.

## Connection settings

The server address is configurable: `--server`, then `FRIENDCOIN_SERVER_URL`, then saved `friendcoin.config.json`. On first launch the client asks for an address and remembers it. Changing an IP or moving to a domain does not require a new binary.

```bash
./friendcoin-macos-arm64 --server ws://185.141.217.117:8088
```

Use that endpoint with this client after the operator has deployed a compatible protocol 2 server. The running legacy server uses a different protocol. For a future domain, save a `wss://` URL.

Wallets, settings and local state normally live in `friendcoin-data` beside the executable. Keep that directory when replacing the executable, or choose a stable location with `--data-dir PATH`. Use `--wallet PATH` to open a file or folder directly.

## Run from source

Source execution requires Node.js 22 or newer:

```bash
npm ci
npm run client -- --server wss://your-domain.example
```

For a test network use `--network testnet --server ws://your-test-relay:8088`. The test relay is operated separately. Testnet coins do not affect mainnet balances.

## Commands

The command prompt keeps the original command-based workflow:

- `balance`, `address`, `friends`
- `send <address|name> <amount> [fee]`
- `mine`, `stop`
- `info`, `history`, `syncpool`
- `help`, `exit`

A transfer shows its full recipient address and asks for confirmation before signing.

## Build and release

```bash
npm test
npm run test:release
npm run build
npm run build:smoke
```

GitHub Actions tests and builds each of the four desktop targets. A matching version tag publishes the client binaries and checksums after all targets pass. Server integration checks run separately in the private project; the public build does not fetch or embed server sources.

See [release instructions](docs/RELEASE.md), [client migration](docs/MIGRATION.md) and [protocol rules](docs/PROTOCOL.md).
