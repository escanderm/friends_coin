# FriendCoin v2 migration

This release candidate is a new protocol and network. The running v1 server is not upgraded by building, pushing code, or publishing a release.

## Prepared balance checkpoint

The mainnet candidate preserves 2554.00 FC across three addresses from 112 v1 blocks, through height 111.

- Legacy tip: `000000049271b8befbf853187e22b401cc192dbbaf476d0e332c481a4b72a7fb`.
- Legacy genesis: `ba5a60b5d817248a4a5fd3c2be6c2f8b7dbb5583fab34f830ee41ad3e84e05d3`.
- SHA-256 of the source backup: `4e12ebacf31451e19bc683330321b38ddc3c509eec2e652710f7761b2c14e2ea`.
- Public source allocations: `networks/legacy-checkpoint.json`.
- New rules and allocations: `networks/mainnet.json`.
- V2 genesis epoch: `2026-10-12T22:17:27Z`.

This is an operator-selected migration checkpoint, not a proof that the insecure v1 protocol rejected every invalid historical operation. Review the allocations with the holders before activation. If v1 advances after this snapshot, prepare a new checkpoint and release candidate before switching the network; do not overwrite an already distributed genesis silently.

The old RSA keys remain valid. Their public keys derive the new checksummed FC2 addresses. Legacy coins are converted exactly to hundredths; negative balances or finer historical precision stop checkpoint preparation. Wallet import is explicit and produces a separate encrypted `.fcwallet` file. Original wallet files are never rewritten by migration.

## Proposed monetary rules

The candidate issues 1.00 FC per block, until total issuance including the 2554.00 FC checkpoint reaches 1,000,000.00 FC. Fees are transfers from senders to miners, not extra issuance. After the cap, miners receive fees only. The minimum fee is 0.01 FC. Blocks target a ten-minute interval, with bounded target adjustment every 50 blocks. These rules are committed by the genesis/rules hash and need agreement before activation.

Testnet is a separate network with no mainnet allocations and easy mining. Its coins do not affect existing balances.

## Candidate validation

Candidate commit `2be95ce` passed the [GitHub CI run](https://github.com/escanderm/friends_coin/actions/runs/38317221105): source tests on Node.js 22 and native client builds on macOS arm64, macOS x64, Linux x64, and Windows x64. Each native target passed the source and publisher tests, binary smoke checks, and `npm run build:e2e`.

The compiled client testnet workflow opens a synthetic encrypted wallet without echoing its password, mines a block, sends and confirms a signed transfer, checks the recipient balance and shared chain tip, then restarts the client and verifies persisted height and balance. It also verifies that the wallet file is unchanged. These checks use temporary directories and a local testnet server; they do not migrate production or publish a release.

## Activation procedure

1. Download the tagged client release and checksums for every supported platform when it is published, and verify the files. The candidate builds and compiled transfer, mining and restart checks have passed CI. Before cutover, also test installation, legacy import and recovery with synthetic wallets in the intended deployment environment.
2. Agree on the monetary rules, checkpoint and cutover with the holders. Confirm the v1 tip and balances still match the checkpoint.
3. Stop v1 mining and transactions for the cutover. Back up the existing server code, configuration and all three v1 data files off the server. Each holder backs up their own wallet; private keys do not belong on the relay or in GitHub.
4. Preserve the old deployment and its data. Install v2 into a separate directory and data volume. Do not point it at the v1 JSON files.
5. Start the v2 archive/relay, provision the public WSS endpoint, then update clients and import their own wallets. Verify the shared genesis and every checkpoint balance before real transfers.
6. Test a small transfer, confirm it in a mined block, restart the archive, and verify the same tip and balances on two independent clients.

The repository does not perform these production steps automatically. The existing server was accessed with read-only authorization.

## Server container

The Dockerfile runs as the Node image's unprivileged `node` user. Prepare a dedicated writable `/data` mount owned by that user (UID/GID 1000 in this image). Keep the HTTP download and WebSocket ports distinct from other services on the host. The current v1 server uses ports 8088/8089; activation must resolve that conflict deliberately.

The separate Container CI workflow builds the server image and checks an unprivileged read-only runtime, loopback HTTP/WebSocket endpoints, transfer/block acceptance and recovery after restarting the same data volume. It uses synthetic keys and a fresh client for the recovery check. Check this workflow's result separately from the successful client run above.

Use `--relay-only` for a transport with no persisted ledger. The default archive independently checks and stores a copy, serves historical blocks, and has no minting or privileged consensus role.

## Recovery

State is stored per network in `<data-dir>/<networkId>/chain.json`. The previous verified state is `chain.json.bak`. A corrupt primary stops startup without creating a replacement genesis. With the node stopped, `--restore-backup` verifies the backup first and preserves the original file as `chain.json.before-restore-<timestamp>`.

An exclusive node lock protects each data directory. Acquisition is serialized with the `.node.lock.acquire` directory; a normal stale PID lock is recovered under that guard. If a process dies during the short acquisition phase, startup stops on the remaining acquisition directory. Check that the recorded process is gone and every node using that directory is stopped before manually removing the acquisition guard. Never delete a live process's lock.

Restarting the old deployment is a rollback only before v2 transfers begin. Once people have transferred or mined v2 coins, switching back to v1 would omit those operations; reconcile them explicitly rather than silently discarding balances.

## Remaining release constraints

The four target binaries have passed build, smoke and compiled client testnet checks in GitHub CI; local validation also covers macOS arm64. A tagged release still requires its publication workflow, and the Docker checks run separately. Developer ID / Windows Authenticode signing is not configured; checksums do not replace platform signing. Gatekeeper or SmartScreen may require the user to approve a downloaded executable. A public deployment needs WSS/TLS, monitoring and backups. Small PoW networks have limited resistance to hash-power attacks; independent review is still needed before relying on this network for meaningful external payments.
