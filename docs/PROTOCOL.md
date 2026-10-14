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

## NFT extension v1

`nftActivationHeight` is an optional network parameter. It is excluded from the legacy rules/genesis hash to preserve all historical v2 blocks. Before the activation height, blocks use the original rules hash and reject NFT actions. From activation onward, blocks must use the NFT rules hash, which commits to the legacy rules hash, activation height, 5% miner / 1% author sale shares, floor rounding, and the 100-unit minimum sale price. Mainnet activates at height 4. A peer's `hello` and server's `welcome` must carry an identical `upgradeHash`; legacy or differently configured peers are rejected.

NFT transactions use the separate `FriendCoin/NFT/transaction/v1` signing domain with fixed field order, the existing RSA keys, addresses, account nonces and proof of work. Types: `nft_mint`, `nft_transfer`, `nft_offer`, `nft_cancel`, `nft_buy`. The identifier commits to network, minting address and account nonce. Metadata is bounded, immutable, and contains a name, description, optional HTTPS/IPFS image URI and SHA-256 digest. Images and private keys never enter transaction payloads.

Each token tracks its immutable creator, current owner, revision and optional sale price. Every NFT action increments its revision. Listing/cancelling/gifting requires the owner's signature; gifting also cancels any listing. A buy requires the buyer's signature and the exact seller, price and revision of the active listing. A successful buy clears the listing and transfers ownership atomically with payment. A pending purchase reserves the buyer's balance and token revision. Fork selection recomputes NFT state along with accounts and reconciles detached transactions.

For a price P in minimal units, miner = floor(P*5/100), author = floor(P/100), seller = P-miner-author. The buyer is debited exactly P. `feeUnits` must equal the miner share, is included in P, and is paid by coinbase together with ordinary block reward and other fees. Creator, seller, buyer and miner account overlaps are supported. Other NFT actions pay the network minimum fee. Listing's `amountUnits` is its asking price, not an immediate transfer. Mint/cancel/gift use zero `amountUnits`.

Ownership is derived only by replaying validated blocks, never from mutable sidecar records. PoW reorganization remains possible; NFT transfers have the same confirmation model as FC. This extension is native FriendCoin functionality, not an EVM contract or ERC-721.
