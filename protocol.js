"use strict";
const crypto = require("node:crypto");
const COIN = 100, VERSION = 2, ZERO_HASH = "0".repeat(64);
const MAX_FUTURE_MS = 7200000, RETARGET_FACTOR = 4;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const NETWORK_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TRANSFER_FIELDS = ["version", "networkId", "from", "to", "amountUnits", "feeUnits", "nonce", "publicKey", "timestamp", "signature"];
const BLOCK_FIELDS = ["version", "networkId", "rulesHash", "height", "timestamp", "previousHash", "target", "nonce", "transactions", "hash"];
class ProtocolError extends Error {
  constructor(code, message) { super(message); this.name = "ProtocolError"; this.code = code; }
}
function fail(code, message) { throw new ProtocolError(code, message); }
function assert(condition, code, message) { if (!condition) fail(code, message); }
function isSafeInteger(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function safeAdd(a, b) { const result = a + b; assert(isSafeInteger(result), "UNSAFE_AMOUNT", "Amount exceeds the safe integer range"); return result; }
function onlyFields(value, fields, code) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), code, "Expected an object");
  assert(Object.keys(value).every(key => fields.includes(key)), code, "Unexpected fields");
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function publicKeyObject(input) {
  let key;
  try {
    if (input instanceof crypto.KeyObject) { assert(input.type === "public", "BAD_PUBLIC_KEY", "Expected a public key"); key = input; }
    else {
      assert(typeof input === "string" && input.length <= 2048 && input.includes("-----BEGIN PUBLIC KEY-----"), "BAD_PUBLIC_KEY", "Expected a PEM SPKI public key");
      key = crypto.createPublicKey(input);
    }
  } catch (error) { if (error instanceof ProtocolError) throw error; fail("BAD_PUBLIC_KEY", "Invalid public key"); }
  assert(key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength === 2048 && key.asymmetricKeyDetails?.publicExponent === 65537n, "BAD_PUBLIC_KEY", "A standard 2048-bit RSA key is required");
  return key;
}
function canonicalPublicKey(input) { return publicKeyObject(input).export({ type: "spki", format: "pem" }); }
function addressFromPublicKey(input) {
  const digest = sha256(publicKeyObject(input).export({ type: "spki", format: "der" }));
  return "FC2_" + digest + "_" + sha256("FriendCoin/address/v2:" + digest).slice(0, 8);
}
function isAddress(address) {
  if (typeof address !== "string" || !/^FC2_[0-9a-f]{64}_[0-9a-f]{8}$/.test(address)) return false;
  return address.slice(69) === sha256("FriendCoin/address/v2:" + address.slice(4, 68)).slice(0, 8);
}
function targetToBigInt(target) {
  assert(typeof target === "string" && HASH_PATTERN.test(target), "BAD_TARGET", "Target must be 64 lowercase hexadecimal digits");
  const numeric = BigInt("0x" + target);
  assert(numeric > 0n, "BAD_TARGET", "Target must be greater than zero"); return numeric;
}
function targetToHex(target) {
  assert(typeof target === "bigint" && target > 0n && target < (1n << 256n), "BAD_TARGET", "Invalid numeric target");
  return target.toString(16).padStart(64, "0");
}
function hashMeetsTarget(hash, target) { return typeof hash === "string" && HASH_PATTERN.test(hash) && BigInt("0x" + hash) <= targetToBigInt(target); }
function blockWork(target) { return (1n << 256n) / (targetToBigInt(target) + 1n); }
function parseAmountUnits(input) {
  assert(typeof input === "string" || typeof input === "number", "BAD_AMOUNT", "Enter an amount in coins");
  const text = String(input).trim();
  assert(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(text), "BAD_AMOUNT", "Amount must have at most two decimal places");
  const [whole, fraction = ""] = text.split(".");
  const units = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  assert(units <= BigInt(Number.MAX_SAFE_INTEGER), "UNSAFE_AMOUNT", "Amount exceeds the safe integer range"); return Number(units);
}
function formatAmountUnits(units) {
  assert(isSafeInteger(units), "BAD_AMOUNT", "Expected integer minimal units");
  return (BigInt(units) / 100n).toString() + "." + (BigInt(units) % 100n).toString().padStart(2, "0");
}
function transactionPayload(tx) {
  // Fixed order and JSON separators are part of the signature protocol.
  return { version: tx.version, networkId: tx.networkId, from: tx.from, to: tx.to, amountUnits: tx.amountUnits, feeUnits: tx.feeUnits, nonce: tx.nonce, publicKey: tx.publicKey, timestamp: tx.timestamp };
}
function transactionSigningBytes(tx) { return Buffer.from("FriendCoin/transaction/v2\n" + JSON.stringify(transactionPayload(tx)), "utf8"); }
function transactionId(tx) { return sha256(transactionSigningBytes(tx)); }
function normalizeTransaction(raw, network, { allowUnsigned = false } = {}) {
  onlyFields(raw, TRANSFER_FIELDS, "BAD_TRANSACTION");
  assert(raw.version === VERSION, "BAD_VERSION", "Unsupported transaction version");
  assert(typeof raw.networkId === "string" && NETWORK_PATTERN.test(raw.networkId), "BAD_NETWORK", "Invalid network identifier");
  if (network) assert(raw.networkId === network.networkId, "BAD_NETWORK", "Transaction belongs to another network");
  assert(isAddress(raw.from) && isAddress(raw.to), "BAD_ADDRESS", "Invalid sender or recipient address");
  assert(raw.from !== raw.to, "SELF_TRANSFER", "Sender and recipient must differ");
  assert(isSafeInteger(raw.amountUnits, 1) && isSafeInteger(raw.feeUnits), "BAD_AMOUNT", "Amounts must be safe integers and transfer amount must be positive");
  safeAdd(raw.amountUnits, raw.feeUnits);
  if (network) {
    assert(raw.feeUnits >= network.minFeeUnits, "FEE_TOO_LOW", "Transaction fee is below the network minimum");
    assert(raw.amountUnits <= network.maxSupplyUnits && raw.feeUnits <= network.maxSupplyUnits, "BAD_AMOUNT", "Amount exceeds the supply limit");
  }
  assert(isSafeInteger(raw.nonce, 1), "BAD_NONCE", "Nonce must be a positive safe integer");
  assert(isSafeInteger(raw.timestamp, 1), "BAD_TIMESTAMP", "Invalid transaction timestamp");
  const publicKey = canonicalPublicKey(raw.publicKey);
  assert(publicKey === raw.publicKey && addressFromPublicKey(publicKey) === raw.from, "BAD_SENDER", "Public key must be canonical and match the sender");
  const tx = { ...transactionPayload(raw), signature: raw.signature ?? null };
  if (allowUnsigned && tx.signature === null) return tx;
  assert(typeof tx.signature === "string" && tx.signature.length === 344, "BAD_SIGNATURE", "Missing or malformed signature");
  const signature = Buffer.from(tx.signature, "base64");
  assert(signature.length === 256 && signature.toString("base64") === tx.signature, "BAD_SIGNATURE", "Signature must use canonical base64");
  let valid = false;
  try { valid = crypto.verify("sha256", transactionSigningBytes(tx), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, signature); } catch {}
  assert(valid, "BAD_SIGNATURE", "Invalid transaction signature"); return tx;
}
function normalizeCoinbase(raw, network) {
  onlyFields(raw, ["version", "type", "networkId", "height", "to", "amountUnits", "timestamp"], "BAD_COINBASE");
  assert(raw.version === VERSION && raw.type === "coinbase" && raw.networkId === network.networkId, "BAD_COINBASE", "Invalid coinbase version, type or network");
  assert(isSafeInteger(raw.height, 1) && isSafeInteger(raw.timestamp, 1) && isAddress(raw.to) && isSafeInteger(raw.amountUnits), "BAD_COINBASE", "Invalid coinbase fields");
  return { version: VERSION, type: "coinbase", networkId: raw.networkId, height: raw.height, to: raw.to, amountUnits: raw.amountUnits, timestamp: raw.timestamp };
}
function validateNetwork(raw) {
  const fields = ["networkId", "protocolVersion", "decimals", "blockRewardUnits", "maxSupplyUnits", "minFeeUnits", "maxTransactionsPerBlock", "targetBlockTime", "adjustmentInterval", "initialTarget", "maxTarget", "genesis"];
  onlyFields(raw, fields, "BAD_NETWORK_CONFIG");
  assert(typeof raw.networkId === "string" && NETWORK_PATTERN.test(raw.networkId), "BAD_NETWORK_CONFIG", "Invalid network identifier");
  assert(raw.protocolVersion === VERSION && raw.decimals === 2, "BAD_NETWORK_CONFIG", "Protocol v2 uses two decimal places");
  for (const field of ["blockRewardUnits", "maxSupplyUnits", "minFeeUnits", "maxTransactionsPerBlock", "targetBlockTime", "adjustmentInterval"]) assert(isSafeInteger(raw[field], 1), "BAD_NETWORK_CONFIG", "Invalid " + field);
  assert(raw.blockRewardUnits <= raw.maxSupplyUnits && raw.minFeeUnits <= raw.maxSupplyUnits, "BAD_NETWORK_CONFIG", "Reward or fee exceeds supply limit");
  assert(raw.maxTransactionsPerBlock <= 1000 && raw.adjustmentInterval >= 2 && raw.adjustmentInterval <= 100000, "BAD_NETWORK_CONFIG", "Block or adjustment interval is outside supported bounds");
  assert(Number.isSafeInteger(raw.targetBlockTime * raw.adjustmentInterval * 1000 * RETARGET_FACTOR), "BAD_NETWORK_CONFIG", "Target interval is too large");
  assert(targetToBigInt(raw.initialTarget) <= targetToBigInt(raw.maxTarget), "BAD_NETWORK_CONFIG", "Initial target exceeds maximum target");
  onlyFields(raw.genesis, ["timestamp", "allocations", "legacyCheckpoint"], "BAD_NETWORK_CONFIG");
  assert(isSafeInteger(raw.genesis.timestamp) && Array.isArray(raw.genesis.allocations), "BAD_NETWORK_CONFIG", "Invalid genesis configuration");
  let total = 0;
  const addresses = new Set();
  const allocations = raw.genesis.allocations.map(allocation => {
    onlyFields(allocation, ["address", "amountUnits"], "BAD_NETWORK_CONFIG");
    assert(isAddress(allocation.address) && isSafeInteger(allocation.amountUnits, 1), "BAD_NETWORK_CONFIG", "Invalid genesis allocation");
    assert(!addresses.has(allocation.address), "BAD_NETWORK_CONFIG", "Duplicate genesis allocation"); addresses.add(allocation.address);
    total = safeAdd(total, allocation.amountUnits);
    return Object.freeze({ address: allocation.address, amountUnits: allocation.amountUnits });
  }).sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  assert(total <= raw.maxSupplyUnits, "BAD_NETWORK_CONFIG", "Genesis allocations exceed the supply cap");
  let legacyCheckpoint = null;
  if (raw.genesis.legacyCheckpoint != null) {
    onlyFields(raw.genesis.legacyCheckpoint, ["height", "hash"], "BAD_NETWORK_CONFIG");
    assert(isSafeInteger(raw.genesis.legacyCheckpoint.height) && typeof raw.genesis.legacyCheckpoint.hash === "string" && HASH_PATTERN.test(raw.genesis.legacyCheckpoint.hash), "BAD_NETWORK_CONFIG", "Invalid legacy checkpoint");
    legacyCheckpoint = Object.freeze({ height: raw.genesis.legacyCheckpoint.height, hash: raw.genesis.legacyCheckpoint.hash });
  }
  const config = Object.fromEntries(fields.filter(field => field !== "genesis").map(field => [field, raw[field]]));
  config.genesis = Object.freeze({ timestamp: raw.genesis.timestamp, allocations: Object.freeze(allocations), legacyCheckpoint });
  return Object.freeze(config);
}
function rulesHash(network) {
  return sha256("FriendCoin/rules/v2\n" + stableStringify({ network, signature: "RSA2048-SHA256-PKCS1v1.5-canonical-json-v2", address: "FC2-SHA256-SPKI-DER-checksum-v2", retargetFactor: RETARGET_FACTOR, maxFutureMs: MAX_FUTURE_MS, retargetStartsAt: "adjustmentInterval+1", coinbasePosition: "first", cappedReward: "min(blockRewardUnits,maxSupplyUnits-issuedUnits)+fees", forkTieBreak: "lowest-tip-hash" }));
}
function blockHeader(block) {
  const transactions = block.transactions.map(tx => {
    if (tx.type === "coinbase") return { version: tx.version, type: tx.type, networkId: tx.networkId, height: tx.height, to: tx.to, amountUnits: tx.amountUnits, timestamp: tx.timestamp };
    if (tx.type === "allocation") return { version: tx.version, type: tx.type, networkId: tx.networkId, to: tx.to, amountUnits: tx.amountUnits };
    return { ...transactionPayload(tx), signature: tx.signature };
  });
  return { version: block.version, networkId: block.networkId, rulesHash: block.rulesHash, height: block.height, timestamp: block.timestamp, previousHash: block.previousHash, target: block.target, transactions, nonce: block.nonce };
}
function blockSigningBytes(block) { return Buffer.from("FriendCoin/block/v2\n" + JSON.stringify(blockHeader(block)), "utf8"); }
function blockHash(block) { return sha256(blockSigningBytes(block)); }
module.exports = { COIN, VERSION, ZERO_HASH, MAX_FUTURE_MS, RETARGET_FACTOR, HASH_PATTERN, BLOCK_FIELDS, ProtocolError, fail, assert, isSafeInteger, safeAdd, onlyFields, stableStringify, sha256, canonicalPublicKey, addressFromPublicKey, isAddress, targetToBigInt, targetToHex, hashMeetsTarget, blockWork, parseAmountUnits, formatAmountUnits, transactionPayload, transactionSigningBytes, transactionId, normalizeTransaction, normalizeCoinbase, validateNetwork, rulesHash, blockHeader, blockSigningBytes, blockHash };
