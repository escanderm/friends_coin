# FriendCoin 🪙

Your own cryptocurrency — for your own people.

This repository contains the **desktop client**: wallets, signed transfers, mining, local validation and standalone builds. The server implementation and its deployment files are maintained separately.

Version `2.1.0-rc.2` keeps the original wallet menu: **↑ / ↓ and Enter** in an interactive terminal. Encrypted copies of legacy wallets are saved beside the original JSON. This client requires an NFT-aware server with the same activation settings. Mainnet NFT rules activate at block 4; historical blocks and FC addresses are preserved.

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

The last successfully opened wallet is remembered and shown first on the next launch. Its password is still required. A wallet can be open in only one rc.4-or-newer client under the same OS user account, including copies in different folders. A second terminal reports that the wallet is already in use. Close the first client with `exit`; locks left by an exited process are recovered on the next launch. Only the file path is saved in local `friendcoin.ui.json`; no password or private key is saved there.

New wallets are encrypted `.fcwallet` files. Selecting an old `wallet_<name>.json` explicitly imports it into a separate encrypted file beside the original JSON, outside version-specific build folders; the original remains unchanged. Back up the encrypted file and its password separately.

## Connection settings

The server address is configurable: `--server`, then `FRIENDCOIN_SERVER_URL`, then saved `friendcoin.config.json`. On first launch the client asks for an address and remembers it. Changing an IP or moving to a domain does not require a new binary.

```bash
./friendcoin-macos-arm64 --server ws://185.141.217.117:8088
```

Use a protocol 2 endpoint with this client. For a future domain, save a `wss://` URL.

Wallets, settings and local state normally live in `friendcoin-data` beside the executable. Keep that directory when replacing the executable, or choose a stable location with `--data-dir PATH`. Use `--wallet PATH` to open a file or folder directly.

## Run from source

Source execution requires Node.js 22 or newer:

```bash
npm ci
npm run client -- --server wss://your-domain.example
```

For a test network use `--network testnet --server ws://your-test-relay:8088`. The test relay is operated separately. Testnet coins do not affect mainnet balances.

## Commands

The command guide groups wallet, NFT, mining, network and general commands into separate sections. Wide terminals show two columns; narrow windows use a single column. Interactive output uses restrained colors, while redirected output and `NO_COLOR` stay plain. Wallet and NFT selection still uses arrow keys.

The balance panel labels cached amounts as local data until synchronization completes, then reports the updated balance. Wallet files, chain storage and network rules are unchanged.

The command prompt keeps the original command-based workflow:

- `balance`, `address`, `friends`
- `send <address|name> <amount> [fee]`
- `mine`, `stop`
- `info`, `rules`, `history`, `syncpool`
- `help`, `exit`

`mine` displays one green status line with a spinner, elapsed time, hashrate and checked hashes. It updates in place above the command prompt and fits the terminal width. Redirected output stays plain and does not print repeated progress lines; use `info` for a snapshot. Set `NO_COLOR` to disable color. It searches for one block; after completion or a changed chain tip, use `mine` again. `stop` cancels the search, and `info` includes the current mining status. Status messages preserve any command you are typing.

`syncpool` reports how many nodes were asked, received and added transfers, and the local pending count. An empty pool, a lost connection or a ten-second timeout is reported explicitly.

`rules` displays the active network rules and current mining difficulty: target average block time, adjustment interval, next adjustment height, blocks remaining, observed average over the current period, reward, supply limit and minimum fee. The same details are included in `info`, with a short reminder at startup. Mainnet targets 10 minutes between blocks and recalculates difficulty every 50 blocks (applied to blocks 51, 101 and so on). Individual block times vary.

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

## NFT

Run `nft` to open the arrow-key menu. Mint a JPEG, PNG or WebP (up to 10 MiB), view your confirmed NFTs, list one for sale, cancel a listing, give one away, or buy a listed NFT. Relative image paths such as `../../photo.jpg` work. The local copy is saved under the selected data directory in `nft-media`; the original is unchanged. The file itself is not uploaded. An optional HTTPS/IPFS link and the image hash are recorded permanently with the name and description. Without a public link, recipients need the image file separately.

A purchase moves FC and NFT ownership together in one transaction. The buyer pays the listed price: 94% goes to the seller, 5% to the block miner and 1% to the original minting address. When seller and author are the same wallet, it receives both shares. The usual block reward is additional to the miner's sale share. No additional purchase fee is charged.

Prices start at 1 FC. Miner and author shares are rounded down independently to 0.01 FC; any remainder goes to the seller. Minting, listing, cancelling and gifting use the existing minimum transaction fee (0.01 FC on mainnet). Ordinary FC transfer fees are unchanged. Royalties apply to purchases recorded through this protocol; a gift with a separate off-chain payment cannot be recognized as a sale.

Listings and purchases take effect after mining. A changed price, cancelled listing or changed owner invalidates a previously prepared purchase. The client displays the total and each share before signing. Metadata and the original author address cannot be changed after minting. The author's address identifies the minter; it is not proof of copyright.

`--network nft-testnet` selects a separate, fast NFT test network. The earlier browser experiment under `experiments/nft-lab` has its own ledger and does not automatically mint anything on mainnet.
