"use strict";
const TYPES = new Set(["nft_mint", "nft_transfer", "nft_offer", "nft_cancel", "nft_buy"]);
const FIELDS = ["version", "type", "networkId", "from", "to", "amountUnits", "feeUnits", "nonce", "publicKey", "timestamp", "tokenId", "revision", "metadata", "signature"];
const isNft = tx => TYPES.has(tx?.type);
function payload(tx) {
  const result = Object.fromEntries(FIELDS.filter(key => key !== "signature").map(key => [key, tx[key]]));
  if (tx.metadata && typeof tx.metadata === "object") result.metadata = Object.fromEntries(["name", "description", "imageUri", "imageSha256"].map(key => [key, tx.metadata[key]]));
  return result;
}
function tokenId(networkId, creator, nonce) {
  return require("./protocol").sha256("FriendCoin/NFT/id/v1\n" + JSON.stringify([networkId, creator, nonce]));
}
function splitSale(priceUnits) {
  const { assert, isSafeInteger } = require("./protocol");
  assert(isSafeInteger(priceUnits, 100), "BAD_NFT_PRICE", "Цена NFT должна быть не меньше 1 FC");
  const minerUnits = Number(BigInt(priceUnits) * 5n / 100n);
  const authorUnits = Number(BigInt(priceUnits) / 100n);
  return { minerUnits, authorUnits, sellerUnits: priceUnits - minerUnits - authorUnits };
}
function normalize(raw, network, { allowUnsigned = false } = {}) {
  const crypto = require("node:crypto");
  const p = require("./protocol");
  const { assert, isSafeInteger, isAddress, HASH_PATTERN } = p;
  p.onlyFields(raw, FIELDS, "BAD_TRANSACTION");
  assert(raw.version === 2 && isNft(raw), "BAD_VERSION", "Unsupported NFT transaction");
  assert(typeof raw.networkId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(raw.networkId), "BAD_NETWORK", "Invalid network");
  if (network) {
    assert(raw.networkId === network.networkId, "BAD_NETWORK", "Transaction belongs to another network");
    assert(network.nftActivationHeight !== undefined, "NFT_DISABLED", "NFT ещё не включены в этой сети");
  }
  assert(isAddress(raw.from) && isAddress(raw.to), "BAD_ADDRESS", "Invalid NFT address");
  assert(isSafeInteger(raw.amountUnits) && isSafeInteger(raw.feeUnits) && isSafeInteger(raw.nonce, 1) && isSafeInteger(raw.timestamp, 1) && isSafeInteger(raw.revision), "BAD_TRANSACTION", "Invalid NFT numeric fields");
  assert(typeof raw.tokenId === "string" && HASH_PATTERN.test(raw.tokenId), "BAD_NFT_ID", "Invalid NFT identifier");
  const sale = raw.type === "nft_buy", offer = raw.type === "nft_offer";
  if (sale || offer) {
    const split = splitSale(raw.amountUnits);
    if (sale) assert(raw.feeUnits === split.minerUnits, "BAD_NFT_FEE", "Комиссия продажи должна составлять 5% цены");
  } else assert(raw.amountUnits === 0, "BAD_AMOUNT", "NFT action must not carry a coin amount");
  if (network) {
    assert(raw.feeUnits >= network.minFeeUnits, "FEE_TOO_LOW", "Transaction fee is below the network minimum");
    assert(raw.amountUnits <= network.maxSupplyUnits && raw.feeUnits <= network.maxSupplyUnits, "BAD_AMOUNT", "Amount exceeds supply limit");
  }
  const self = ["nft_mint", "nft_offer", "nft_cancel"].includes(raw.type);
  assert(self ? raw.from === raw.to : raw.from !== raw.to, "BAD_ADDRESS", "Invalid NFT action recipient");
  let metadata = null;
  if (raw.type === "nft_mint") {
    assert(raw.revision === 0 && raw.tokenId === tokenId(raw.networkId, raw.from, raw.nonce), "BAD_NFT_ID", "Mint identifier or revision does not match issuer");
    p.onlyFields(raw.metadata, ["name", "description", "imageUri", "imageSha256"], "BAD_NFT_METADATA");
    const m = raw.metadata;
    for (const [field, max, min] of [["name", 120, 1], ["description", 2000, 0], ["imageUri", 1000, 0]]) {
      assert(typeof m[field] === "string" && Buffer.byteLength(m[field], "utf8") <= max && m[field].trim().length >= min && !/[\u0000-\u001f\u007f-\u009f]/.test(m[field]), "BAD_NFT_METADATA", "Invalid NFT " + field);
    }
    assert(m.imageUri === "" || /^(https:\/\/|ipfs:\/\/)/.test(m.imageUri), "BAD_NFT_METADATA", "Image URI must be HTTPS or IPFS, or empty");
    assert(typeof m.imageSha256 === "string" && HASH_PATTERN.test(m.imageSha256), "BAD_NFT_METADATA", "Invalid image hash");
    metadata = Object.freeze({ name: m.name, description: m.description, imageUri: m.imageUri, imageSha256: m.imageSha256 });
  } else assert(raw.metadata === null && raw.revision >= 1, "BAD_NFT_METADATA", "Only mint may set metadata");
  const publicKey = p.canonicalPublicKey(raw.publicKey);
  assert(publicKey === raw.publicKey && p.addressFromPublicKey(publicKey) === raw.from, "BAD_SENDER", "NFT signer does not match sender");
  const tx = { ...payload(raw), metadata, signature: raw.signature ?? null };
  if (allowUnsigned && tx.signature === null) return tx;
  assert(typeof tx.signature === "string" && tx.signature.length === 344, "BAD_SIGNATURE", "Missing NFT signature");
  const signature = Buffer.from(tx.signature, "base64");
  assert(signature.length === 256 && signature.toString("base64") === tx.signature && crypto.verify("sha256", p.transactionSigningBytes(tx), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, signature), "BAD_SIGNATURE", "Invalid NFT signature");
  return tx;
}
function apply(state, tx) {
  const { assert, safeAdd } = require("./protocol");
  const get = address => state.accounts.get(address) ?? { balance: 0, nonce: 0 };
  const sender = get(tx.from);
  assert(tx.nonce === sender.nonce + 1, "BAD_NONCE", "Transaction nonce is not the next account nonce");
  const existing = state.nfts.get(tx.tokenId);
  let updated;
  if (tx.type === "nft_mint") {
    assert(!existing, "NFT_EXISTS", "NFT already exists");
    updated = { id: tx.tokenId, creator: tx.from, owner: tx.to, revision: 1, metadata: tx.metadata, offer: null };
  } else {
    assert(existing, "NFT_NOT_FOUND", "NFT не найден");
    assert(existing.revision === tx.revision && existing.revision < Number.MAX_SAFE_INTEGER, "NFT_STALE", "NFT изменился: обновите данные перед операцией");
    updated = { ...existing, revision: existing.revision + 1 };
    if (tx.type === "nft_buy") {
      assert(existing.owner === tx.to && existing.offer?.priceUnits === tx.amountUnits, "NFT_NOT_FOR_SALE", "Предложение продажи больше не действует");
      updated.owner = tx.from; updated.offer = null;
    } else {
      assert(existing.owner === tx.from, "NFT_NOT_OWNER", "Только текущий владелец может выполнить действие");
      if (tx.type === "nft_transfer") { updated.owner = tx.to; updated.offer = null; }
      if (tx.type === "nft_offer") updated.offer = Object.freeze({ priceUnits: tx.amountUnits });
      if (tx.type === "nft_cancel") {
        assert(existing.offer !== null, "NFT_NOT_FOR_SALE", "Нет активного предложения продажи");
        updated.offer = null;
      }
    }
  }
  // A sale's miner fee is INCLUDED in its price, not charged a second time.
  const cost = tx.type === "nft_buy" ? tx.amountUnits : tx.feeUnits;
  assert(sender.balance >= cost, "INSUFFICIENT_FUNDS", "Недостаточно FC для операции с NFT");
  state.accounts.set(tx.from, { balance: sender.balance - cost, nonce: tx.nonce });
  if (tx.type === "nft_buy") {
    const split = splitSale(tx.amountUnits);
    // Read each account after the previous write: creator, seller and buyer may overlap.
    for (const [address, value] of [[existing.owner, split.sellerUnits], [existing.creator, split.authorUnits]]) {
      const recipient = get(address);
      state.accounts.set(address, { balance: safeAdd(recipient.balance, value), nonce: recipient.nonce });
    }
  }
  state.nfts.set(tx.tokenId, Object.freeze(updated));
}
module.exports = { TYPES, FIELDS, isNft, payload, tokenId, splitSale, normalize, apply };
