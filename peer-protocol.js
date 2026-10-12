const crypto = require("crypto");
const { addressFromPublicKey, canonicalPublicKey, isAddress } = require("./protocol");

const PROTOCOL_VERSION = 2;
const MAX_PAYLOAD = 1024 * 1024;
const MESSAGE_TYPES = new Set(["announce", "transaction", "block", "request_blocks", "blocks", "request_pool", "pool"]);
const NAME_PATTERN = /^[a-zA-Z0-9_]{1,32}$/;

function identityBytes(networkId, challenge, identity) {
  return Buffer.from(JSON.stringify(["friendcoin.identity.v2", networkId, challenge, identity.name, identity.address, identity.publicKey]), "utf8");
}

function signIdentity(wallet, networkId, challenge) {
  const identity = { name: wallet.name, address: wallet.address, publicKey: canonicalPublicKey(wallet.keys.publicKey) };
  identity.signature = crypto.sign("sha256", identityBytes(networkId, challenge, identity), wallet.keys.privateKey).toString("base64");
  return identity;
}

function verifyIdentity(identity, networkId, challenge) {
  if (!identity || !NAME_PATTERN.test(identity.name) || !isAddress(identity.address)) return false;
  if (typeof identity.publicKey !== "string" || identity.publicKey.length > 8192) return false;
  if (typeof identity.signature !== "string" || identity.signature.length > 2048) return false;
  try {
    const publicKey = canonicalPublicKey(identity.publicKey);
    if (publicKey !== identity.publicKey || addressFromPublicKey(publicKey) !== identity.address) return false;
    return crypto.verify("sha256", identityBytes(networkId, challenge, identity), publicKey, Buffer.from(identity.signature, "base64"));
  } catch { return false; }
}

function parseMessage(data) {
  if (data.length > MAX_PAYLOAD) throw new Error("Сообщение слишком большое");
  const message = JSON.parse(data.toString("utf8"));
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
    throw new Error("Неверный формат сообщения");
  }
  return message;
}

function validatePeerMessage(message) {
  if (!MESSAGE_TYPES.has(message.type)) throw new Error("Неизвестный тип сообщения");
  if (message.to !== undefined && (typeof message.to !== "string" || message.to.length > 100)) throw new Error("Неверный получатель");
  if (message.type === "request_blocks") {
    if (!Array.isArray(message.locator) || message.locator.length > 64 || !message.locator.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) throw new Error("Неверный locator");
    if (!Number.isSafeInteger(message.limit) || message.limit < 1 || message.limit > 16) throw new Error("Неверный размер пакета блоков");
  }
  if (["request_blocks", "blocks", "request_pool", "pool"].includes(message.type)) {
    if (typeof message.requestId !== "string" || message.requestId.length > 100) throw new Error("Неверный requestId");
  }
  if (message.type === "blocks" && (!Array.isArray(message.blocks) || message.blocks.length > 16)) throw new Error("Неверный пакет блоков");
  if (message.type === "pool" && (!Array.isArray(message.transactions) || message.transactions.length > 100)) throw new Error("Неверный пул");
  if (message.type === "transaction" && (!message.transaction || typeof message.transaction !== "object")) throw new Error("Неверная транзакция");
  if (message.type === "block" && (!message.block || typeof message.block !== "object")) throw new Error("Неверный блок");
  return message;
}

function tipOf(blockchain) {
  const block = blockchain.getLastBlock();
  return { hash: block.hash, height: block.height, chainwork: blockchain.getChainwork() };
}

module.exports = { PROTOCOL_VERSION, MAX_PAYLOAD, MESSAGE_TYPES, NAME_PATTERN, identityBytes, signIdentity, verifyIdentity, parseMessage, validatePeerMessage, tipOf };
