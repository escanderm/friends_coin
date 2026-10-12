# FriendCoin

FriendCoin is a cryptocurrency project built to learn how wallets, signed transfers, mining, and a shared ledger work. This branch prepares version `2.0.0-rc.1` with protocol 2, encrypted wallets, configurable servers, and standalone clients.

This is a release candidate. The mainnet snapshot is a prepared migration candidate; it does not activate or migrate the existing protocol 1 server. Use testnet to try the new client. Review [release and migration requirements](docs/RELEASE.md) before starting mainnet.

## Run a local testnet

Source builds require Node.js 22 or newer and npm. CI builds standalone clients with Node.js 24.16.0.

Install dependencies:

```bash
npm ci
```

Start the server in one terminal:

```bash
npm start -- --network testnet --data-dir ./testnet-server --host 127.0.0.1 --port 8088 --download-port 8089
```

Start a client in another terminal:

```bash
npm run client -- --network testnet --data-dir ./testnet-client --server ws://127.0.0.1:8088
```

Follow the wallet menu to create or open a wallet. New wallets use the encrypted `.fcwallet` format and require a password. Keep a backup of the wallet file and its password. Losing either prevents you from spending its coins.

Use a separate client data directory for each local user. Server and client state should also use separate directories.

## Client settings

Run `npm run client -- --help` for the full reference. Standalone clients accept the same flags:

- `--server URL` selects a full `ws://` or `wss://` URL and saves it for future launches.
- `--data-dir PATH` selects the directory for settings, wallets, and local state.
- `--network mainnet|testnet` selects the network. The networks have separate state.
- `--wallet PATH` opens a specific wallet file, including a file on an external drive.
- `--relay URL` adds another relay endpoint. Repeat it to configure several relays.
- `--restore-backup` explicitly restores a validated local state backup. It does not restore or replace wallets.
- `--version` prints the client version and exits.
- `--help` prints usage and exits.

By default, data lives in `friendcoin-data` in the source launch directory, or beside the standalone executable. Use `--data-dir` if that directory is not writable or you want to keep your data elsewhere. Settings and wallets remain outside the executable when you replace it with an update.

The server address is chosen in this order: `--server`, `FRIENDCOIN_SERVER_URL`, then saved settings. Without a configured address, the client asks for one before wallet selection. A temporary override on macOS or Linux is:

```bash
FRIENDCOIN_SERVER_URL=ws://127.0.0.1:8088 npm run client -- --network testnet --data-dir ./testnet-client
```

The new IP is `185.141.217.117`. Use `ws://185.141.217.117:8088` after a compatible protocol 2 server has been deployed there. Changing the address alone does not upgrade an older server.

After buying a domain, point its DNS record at your server and configure TLS for the WebSocket endpoint, either on the server or through a reverse proxy. Then save the new URL, replacing `coin.example.com` with your domain:

```bash
npm run client -- --network mainnet --server wss://coin.example.com
```

No source-code change is needed when the IP or domain changes.

## Wallets and backups

Keep `.fcwallet` files private. Their contents are encrypted; opening them requires the wallet password. Use the wallet menu's explicit legacy import option to convert an old `wallet_<name>.json` file. The importer does not silently load every JSON wallet it finds. Keep the original backup until you have opened the converted wallet and verified its address.

A copy of local blockchain state is not a wallet backup. Back up the encrypted wallet itself, and store its password separately. Testnet coins and mainnet coins are separate; choosing a network does not move a balance between them.

## Commands

Enter `help` after opening a wallet to see available commands. The basic commands are:

- `balance` shows your balance.
- `send <address|name> <amount> [fee]` sends coins to an address or a known recipient.
- `mine` mines a block.
- `friends` lists known users.
- `address` shows your address.
- `syncpool` requests the current transaction pool.
- `info` shows the current network, block, relays, and synchronization status.
- `history` shows wallet activity.
- `stop` stops mining.
- `exit` closes the client.

## Standalone clients

Build a client for your current machine:

```bash
npm run build
npm run build:smoke
```

`dist/` contains one executable and its `.sha256` checksum. The build does not deploy, upload, or push anything. Supported release targets are:

- `friendcoin-macos-arm64`
- `friendcoin-macos-x64`
- `friendcoin-linux-x64`
- `friendcoin-windows-x64.exe`

These files include the Node.js runtime, so users do not need to install Node.js. Download the matching executable and checksum from [GitHub Releases](https://github.com/escanderm/friends_coin/releases). The tagged release workflow builds and checks all four targets before publishing a complete set of downloads.

Example on macOS or Linux:

```bash
chmod +x friendcoin-macos-arm64
./friendcoin-macos-arm64 --network testnet --data-dir ./friendcoin-data --server ws://127.0.0.1:8088
```

Example in Windows PowerShell:

```powershell
.\friendcoin-windows-x64.exe --network testnet --data-dir .\friendcoin-data --server ws://127.0.0.1:8088
```

Old binaries still contain old connection and wallet behavior. Rebuild them from this branch; replacing a download link does not update an existing binary.

The legacy download server uses `http://<server>:8089/download`. For the new IP, that would be [the download page](http://185.141.217.117:8089/download), with `/mac`, `/linux`, and `/win` paths if that server provides them. Its availability and the version of files hosted there have not been checked.

## Checks and release process

```bash
npm test
npm run test:release
```

CI runs tests and builds on macOS arm64, macOS x64, Linux x64, and Windows x64. Binary smoke checks verify the checksum, `--version`, `--help`, and exit from the empty wallet menu in a temporary data directory. `npm run build:e2e` then runs the compiled client with a temporary encrypted wallet, mines coins, confirms a transfer to a second client, and checks the same balance after restarting the executable.

See [docs/RELEASE.md](docs/RELEASE.md) for tag naming, GitHub publication, signing limits, and the migration checklist. Passing CI verifies the tested behavior; it does not certify the currency for handling valuable funds.
