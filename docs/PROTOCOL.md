# FriendCoin protocol 2

Every full node validates the same rules. A relay delivers messages; it does not approve balances for clients.

## Money and identity

One FC is 100 integer units. Amounts, fees, nonces, heights and timestamps use checked safe integers. Addresses are `FC2_<SHA-256 of RSA SPKI DER>_<checksum>`. Public keys are canonical RSA-2048 SPKI PEM with exponent 65537. The checksum catches address transcription errors.

Transfers bind version, network ID, sender, recipient, amount units, fee units, sequential sender nonce, canonical public key and timestamp. Signing uses a domain-separated canonical JSON payload and RSA/SHA-256. Transaction IDs hash that payload. Signature verification, balance, nonce, network and fee checks run for pool admission and block application. Pool admission reserves earlier pending expenses and has a 1000-transfer policy cap.

## Blocks and branches

Genesis is deterministic and commits the network rules and initial allocations. A block includes the protocol version, network/rules hashes, height, timestamp, parent hash, numeric 256-bit target, transactions, nonce and calculated hash. Transfers apply in order. The first transaction is the sole coinbase, with exactly the remaining subsidy plus collected fees.

Each node derives the expected target from the validated parent branch. The target adjusts on heights 51, 101 and so on for the mainnet 50-block interval, with a maximum fourfold change. Block timestamps increase strictly and cannot exceed the node clock by more than two hours. Nodes compute chainwork locally as the sum of `floor(2^256/(target+1))`. The highest-work valid branch wins; equal work uses the lowest tip hash. Reorganization recomputes balances and revalidates detached and pending transfers.

Confirmations count blocks above a transfer's block including that block. Ordinary PoW has probabilistic finality: a later valid higher-work branch may change confirmations and balances.

## Transport

Clients announce protocol version, network ID and genesis hash. Application versions can differ while protocol rules match. The relay challenges each connection; the wallet proves possession of its key with a separate identity-signing domain. Nicknames are labels, not global ownership claims. Confirm a recipient's full address with its holder.

Messages announce tips, transfer transactions/blocks, and request/reply to bounded block and pool batches. A block reply contains at most 16 blocks and fits within the one-MiB frame budget, reserving space for the relay's sender ID. Filled blocks may require a shorter reply; synchronization continues from its last validated hash until the advertised tip is known. Relays assign source peer IDs and reject client attempts to spoof them. Clients validate peer identity proofs and every received ledger object themselves. Sync follows the last validated block on a remote branch across batches, even before that branch becomes the selected tip.

Multiple relay connections share one ledger and pool. IDs/hashes deduplicate messages. Connections retry with bounded backoff, and mining cancels when the selected parent changes or connectivity is lost.

## Storage and scope

Wallet files use authenticated AES-256-GCM encryption with random salt/IV and bounded scrypt parameters. State files contain public ledger data, not wallet keys. Atomic state replacement keeps a previous verified backup; corruption fails closed. Imported legacy wallets are never silently overwritten.

This implementation holds validated block branches and states in memory and stores a verified JSON snapshot. It targets a small network. Large-network pruning, a database-backed block index and separate mobile/light clients are future work.
