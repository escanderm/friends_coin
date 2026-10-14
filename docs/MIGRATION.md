# FriendCoin client migration

This client uses protocol 2. Publishing client releases does not automatically deploy server changes.

## Prepared balance checkpoint

The candidate preserves 2554.00 FC across three addresses from 112 legacy blocks through height 111.

- Legacy tip: `000000049271b8befbf853187e22b401cc192dbbaf476d0e332c481a4b72a7fb`.
- Legacy genesis: `ba5a60b5d817248a4a5fd3c2be6c2f8b7dbb5583fab34f830ee41ad3e84e05d3`.
- Source SHA-256: `4e12ebacf31451e19bc683330321b38ddc3c509eec2e652710f7761b2c14e2ea`.
- Source allocations: networks/legacy-checkpoint.json.
- Candidate rules: networks/mainnet.json.

This is an explicitly selected checkpoint, not validation of every historical protocol 1 operation. Holder agreement and an unchanged snapshot are required before activation. If the legacy chain advances, prepare a new candidate; never silently replace an already distributed genesis.

The protocol 2 rules define 1.00 FC per block, a total cap of 1,000,000.00 FC including the checkpoint, and a minimum fee of 0.01 FC. Fees move existing units rather than increasing issuance. Client and server must use the same network configuration.

## Wallets

The existing RSA keys derive the new checksummed FC2 addresses. In the original arrow menu, choose an old wallet or “Загрузить кошелёк с флешки/диска”. A file or relative folder path works. Selecting a legacy JSON wallet explicitly creates a separate encrypted .fcwallet file beside that JSON. The destination is displayed before asking for a password; an existing encrypted file is never overwritten.

Back up the original first. Keep the encrypted file and its password separately, then open the encrypted copy and verify the address. The old file is not rewritten. Only the chosen path is remembered locally; passwords and private keys are not stored in UI settings.

## Client state recovery

Local state lives under <data-dir>/<networkId>/chain.json. The previous verified state is chain.json.bak. Corrupt state stops startup instead of silently creating a new genesis.

With the client stopped, --restore-backup validates the backup and preserves the damaged original. A local directory lock prevents simultaneous writers. If an acquisition guard remains after a crash, confirm every client using the directory is stopped before removing it.

## Activation

Server operations and deployment records are maintained privately. Use an operator-approved protocol 2 endpoint. Protocol 1 clients and servers are incompatible with protocol 2. Testnet is separate and contains no legacy allocations.

Once live protocol 2 transfers begin, reverting to protocol 1 would omit them; recovery must account for those operations.

## NFT activation (2.1.0-rc.1)

The NFT extension activates on mainnet at block 4. It preserves the v2 genesis, all three existing blocks, addresses and balances. Both peers and the archive must agree on `upgradeHash`; clients without the extension cannot join the upgraded relay. Use the matching new desktop executable and the same encrypted wallet. Do not replace or reset chain files.

Before deployment, stop the old archive, back up its data and container configuration, and validate the backup with the new code. Activation requires the saved tip to be below block 4; if the old network advances to block 4 before the switch, do not deploy this configuration. A new height must be selected and shipped consistently to every client and server.

Before any upgraded block is accepted, the saved original container/data can restore the prior service. Once block 4 or later has been accepted, reverting to old rules would discard new operations. Preserve the upgraded data and fix forward instead. The standalone NFT Lab is not migrated and does not grant ownership on mainnet.
