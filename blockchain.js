"use strict";
const crypto = require("node:crypto");
const {
  VERSION, ZERO_HASH, MAX_FUTURE_MS, RETARGET_FACTOR, HASH_PATTERN, BLOCK_FIELDS,
  assert, fail, isSafeInteger, safeAdd, onlyFields, canonicalPublicKey, addressFromPublicKey,
  isAddress, targetToBigInt, targetToHex, hashMeetsTarget, blockWork,
  transactionPayload, transactionSigningBytes, transactionId, normalizeTransaction,
  normalizeCoinbase, validateNetwork, rulesHash, blockSigningBytes, blockHash,
} = require("./protocol");

// Local admission policy; this limit does not change block consensus or genesis.
const MAX_PENDING_TRANSACTIONS = 1000;

class Transaction {
  constructor(data = {}) {
    onlyFields(data, ["version", "networkId", "from", "to", "amountUnits", "feeUnits", "nonce", "publicKey", "timestamp", "signature"], "BAD_TRANSACTION");
    this.version = data.version ?? VERSION;
    this.networkId = data.networkId;
    this.from = data.from ?? null;
    this.to = data.to;
    this.amountUnits = data.amountUnits;
    this.feeUnits = data.feeUnits;
    this.nonce = data.nonce;
    this.publicKey = data.publicKey ?? null;
    this.timestamp = data.timestamp ?? Date.now();
    this.signature = data.signature ?? null;
  }
  getHash() { return transactionId(this); }
  getId() { return this.getHash(); }
  sign(privateKey) {
    let publicKey;
    try { publicKey = canonicalPublicKey(crypto.createPublicKey(privateKey)); }
    catch { fail("BAD_PRIVATE_KEY", "A valid 2048-bit RSA private key is required"); }
    const address = addressFromPublicKey(publicKey);
    assert(this.from === null || this.from === address, "BAD_SENDER", "Private key does not match sender");
    assert(this.publicKey === null || canonicalPublicKey(this.publicKey) === publicKey, "BAD_SENDER", "Private key does not match transaction public key");
    this.from = address;
    this.publicKey = publicKey;
    this.signature = null;
    normalizeTransaction(this, null, { allowUnsigned: true });
    this.signature = crypto.sign("sha256", transactionSigningBytes(this), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString("base64");
    return this;
  }
  isValid(network) { try { normalizeTransaction(this, network); return true; } catch { return false; } }
  toJSON() { return { ...transactionPayload(this), signature: this.signature }; }
}

class Block {
  constructor(data) {
    this.version = data.version;
    this.networkId = data.networkId;
    this.rulesHash = data.rulesHash;
    this.height = data.height;
    this.timestamp = data.timestamp;
    this.previousHash = data.previousHash;
    this.target = data.target;
    this.nonce = data.nonce;
    this.transactions = data.transactions;
    this.hash = data.hash ?? this.calculateHash();
  }
  calculateHash() { return blockHash(this); }
  toJSON() {
    return { version: this.version, networkId: this.networkId, rulesHash: this.rulesHash,
      height: this.height, timestamp: this.timestamp, previousHash: this.previousHash,
      target: this.target, nonce: this.nonce,
      transactions: this.transactions.map(tx => typeof tx.toJSON === "function" ? tx.toJSON() : { ...tx }), hash: this.hash };
  }
}

function freezeBlock(block) {
  for (const tx of block.transactions) Object.freeze(tx);
  Object.freeze(block.transactions);
  return Object.freeze(block);
}
function cloneState(state) {
  return { accounts: new Map(Array.from(state.accounts, ([address, value]) => [address, { ...value }])), issuedUnits: state.issuedUnits };
}
function account(state, address) { return state.accounts.get(address) ?? { balance: 0, nonce: 0 }; }
function applyTransaction(state, tx) {
  const sender = account(state, tx.from);
  assert(sender.nonce < Number.MAX_SAFE_INTEGER && tx.nonce === sender.nonce + 1, "BAD_NONCE", "Transaction nonce is not the next account nonce");
  const cost = safeAdd(tx.amountUnits, tx.feeUnits);
  assert(sender.balance >= cost, "INSUFFICIENT_FUNDS", "Insufficient balance including fee");
  const recipient = account(state, tx.to);
  state.accounts.set(tx.from, { balance: sender.balance - cost, nonce: tx.nonce });
  state.accounts.set(tx.to, { balance: safeAdd(recipient.balance, tx.amountUnits), nonce: recipient.nonce });
}
function isBetter(node, current) {
  return node.chainwork > current.chainwork || (node.chainwork === current.chainwork && node.block.hash < current.block.hash);
}

class Blockchain {
  constructor(network) {
    this.network = validateNetwork(network ?? require("./networks/mainnet.json"));
    this.rulesHash = rulesHash(this.network);
    this.pendingTransactions = [];
    const genesis = freezeBlock(this.createGenesisBlock());
    const state = { accounts: new Map(), issuedUnits: 0 };
    for (const allocation of this.network.genesis.allocations) {
      state.accounts.set(allocation.address, { balance: allocation.amountUnits, nonce: 0 });
      state.issuedUnits = safeAdd(state.issuedUnits, allocation.amountUnits);
    }
    this._blocks = new Map();
    this._tip = { block: genesis, parent: null, chainwork: 0n, state };
    this._blocks.set(genesis.hash, this._tip);
    this.chain = Object.freeze([genesis]);
    this.genesisHash = genesis.hash;
  }
  createGenesisBlock() {
    return new Block({ version: VERSION, networkId: this.network.networkId, rulesHash: this.rulesHash,
      height: 0, timestamp: this.network.genesis.timestamp, previousHash: ZERO_HASH,
      target: this.network.initialTarget, nonce: 0,
      transactions: this.network.genesis.allocations.map(value => ({ version: VERSION, type: "allocation", networkId: this.network.networkId, to: value.address, amountUnits: value.amountUnits })) });
  }
  getLastBlock() { return this._tip.block; }
  getBlock(hash) { return this._blocks.get(hash)?.block ?? null; }
  hasBlock(hash) { return this._blocks.has(hash); }
  getChainwork() { return this._tip.chainwork.toString(); }
  getBalanceUnits(address) { return account(this._tip.state, address).balance; }
  getConfirmedNonce(address) { return account(this._tip.state, address).nonce; }
  getIssuedUnits() { return this._tip.state.issuedUnits; }
  _poolState() {
    const state = cloneState(this._tip.state);
    for (const tx of this.pendingTransactions) applyTransaction(state, normalizeTransaction(tx, this.network));
    return state;
  }
  getAvailableBalanceUnits(address) { return account(this._poolState(), address).balance; }
  getNextNonce(address) {
    const nonce = account(this._poolState(), address).nonce;
    assert(nonce < Number.MAX_SAFE_INTEGER, "NONCE_EXHAUSTED", "Account nonce range is exhausted"); return nonce + 1;
  }
  addTransaction(raw) {
    assert(this.pendingTransactions.length < MAX_PENDING_TRANSACTIONS, "POOL_FULL", "Pending transaction pool is full");
    const tx = new Transaction(normalizeTransaction(raw, this.network));
    assert(tx.timestamp <= Date.now() + MAX_FUTURE_MS, "BAD_TIMESTAMP", "Transaction timestamp is too far in the future");
    assert(!this.pendingTransactions.some(existing => existing.getId() === tx.getId()), "DUPLICATE_TRANSACTION", "Transaction is already pending");
    const state = this._poolState(); applyTransaction(state, tx);
    this.pendingTransactions.push(Object.freeze(tx)); return tx;
  }
  _expectedTarget(parent) {
    const interval = this.network.adjustmentInterval, nextHeight = parent.block.height + 1;
    if (nextHeight === 1 || (nextHeight - 1) % interval !== 0) return parent.block.target;
    let start = parent;
    for (let i = 0; i < interval; i++) start = start.parent;
    assert(start !== null, "BAD_TARGET", "Insufficient history for target adjustment");
    const expected = BigInt(this.network.targetBlockTime * interval * 1000);
    let elapsed = BigInt(parent.block.timestamp - start.block.timestamp);
    const minimum = expected / BigInt(RETARGET_FACTOR), maximum = expected * BigInt(RETARGET_FACTOR);
    if (elapsed < minimum) elapsed = minimum;
    if (elapsed > maximum) elapsed = maximum;
    let target = targetToBigInt(parent.block.target) * elapsed / expected;
    if (target < 1n) target = 1n;
    const maximumTarget = targetToBigInt(this.network.maxTarget);
    if (target > maximumTarget) target = maximumTarget;
    return targetToHex(target);
  }
  getNextTarget() { return this._expectedTarget(this._tip); }
  getDifficultyLabel() { return blockWork(this.getNextTarget()).toLocaleString("en-US") + " expected hashes"; }
  _normalizeBlock(raw) {
    const source = raw instanceof Block ? raw.toJSON() : raw;
    onlyFields(source, BLOCK_FIELDS, "BAD_BLOCK");
    assert(source.version === VERSION && source.networkId === this.network.networkId, "BAD_NETWORK", "Block belongs to another protocol or network");
    assert(source.rulesHash === this.rulesHash, "BAD_RULES", "Block uses another network rule set");
    assert(isSafeInteger(source.height) && isSafeInteger(source.timestamp) && isSafeInteger(source.nonce), "BAD_BLOCK", "Invalid block height, timestamp or nonce");
    assert(typeof source.previousHash === "string" && HASH_PATTERN.test(source.previousHash) && typeof source.hash === "string" && HASH_PATTERN.test(source.hash), "BAD_HASH", "Invalid block hash encoding");
    assert(targetToBigInt(source.target) <= targetToBigInt(this.network.maxTarget), "BAD_TARGET", "Declared target exceeds network maximum");
    assert(Array.isArray(source.transactions), "BAD_BLOCK", "Block transactions must be an array");
    if (source.height === 0) {
      assert(source.hash === this.genesisHash && blockHash(source) === this.genesisHash, "BAD_GENESIS", "Genesis does not match this network"); return this.chain[0];
    }
    assert(source.transactions.length >= 1 && source.transactions.length <= this.network.maxTransactionsPerBlock + 1, "BAD_BLOCK", "Invalid number of transactions");
    const transactions = [normalizeCoinbase(source.transactions[0], this.network)];
    for (const tx of source.transactions.slice(1)) transactions.push(normalizeTransaction(tx, this.network));
    const block = new Block({ ...source, transactions });
    assert(block.calculateHash() === block.hash, "BAD_HASH", "Block hash does not match its contents");
    assert(hashMeetsTarget(block.hash, block.target), "BAD_POW", "Block does not satisfy its proof-of-work target"); return block;
  }
  _validateAndApply(block, parent) {
    assert(block.height === parent.block.height + 1, "BAD_HEIGHT", "Block height does not extend its parent");
    assert(block.previousHash === parent.block.hash, "BAD_PARENT", "Block parent hash does not match");
    assert(block.target === this._expectedTarget(parent), "BAD_TARGET", "Block target does not match the expected target");
    assert(block.timestamp > parent.block.timestamp && block.timestamp <= Date.now() + MAX_FUTURE_MS, "BAD_TIMESTAMP", "Block timestamp must increase and remain within the future bound");
    const state = cloneState(parent.state); let fees = 0;
    for (const tx of block.transactions.slice(1)) {
      assert(tx.timestamp <= block.timestamp, "BAD_TIMESTAMP", "Transaction timestamp exceeds block timestamp");
      applyTransaction(state, tx); fees = safeAdd(fees, tx.feeUnits);
    }
    const reward = Math.min(this.network.blockRewardUnits, this.network.maxSupplyUnits - parent.state.issuedUnits);
    const coinbase = block.transactions[0];
    assert(coinbase.height === block.height && coinbase.timestamp === block.timestamp && coinbase.amountUnits === safeAdd(reward, fees), "BAD_COINBASE", "Coinbase amount, height or timestamp is invalid");
    const miner = account(state, coinbase.to);
    state.accounts.set(coinbase.to, { balance: safeAdd(miner.balance, coinbase.amountUnits), nonce: miner.nonce });
    state.issuedUnits = safeAdd(state.issuedUnits, reward);
    assert(state.issuedUnits <= this.network.maxSupplyUnits, "SUPPLY_EXCEEDED", "Block exceeds maximum supply"); return state;
  }
  _reconcilePool(candidates) {
    const state = cloneState(this._tip.state), seen = new Set(), remaining = [];
    let waiting = candidates;
    while (waiting.length && remaining.length < MAX_PENDING_TRANSACTIONS) {
      const deferred = []; let progress = false;
      for (const raw of waiting) {
        if (remaining.length >= MAX_PENDING_TRANSACTIONS) break;
        try {
          const tx = new Transaction(normalizeTransaction(raw, this.network)), id = tx.getId();
          if (seen.has(id)) continue;
          assert(tx.timestamp <= Date.now() + MAX_FUTURE_MS, "BAD_TIMESTAMP", "Transaction is too far in the future");
          applyTransaction(state, tx); seen.add(id); remaining.push(Object.freeze(tx)); progress = true;
        } catch (error) { if (error.code === "BAD_NONCE" || error.code === "INSUFFICIENT_FUNDS") deferred.push(raw); }
      }
      if (!progress) break; waiting = deferred;
    }
    this.pendingTransactions = remaining;
  }
  _selectTip(node) {
    const previousChain = this.chain, chain = [];
    for (let cursor = node; cursor; cursor = cursor.parent) chain.push(cursor.block);
    chain.reverse();
    const chosen = new Set(chain.map(block => block.hash));
    const detached = previousChain.filter(block => !chosen.has(block.hash)).flatMap(block => block.transactions.slice(1));
    this._tip = node; this.chain = Object.freeze(chain);
    this._reconcilePool([...detached, ...this.pendingTransactions]);
  }
  receiveBlock(raw) {
    const block = this._normalizeBlock(raw);
    const result = { accepted: false, tipChanged: false, missingParent: null, duplicate: false };
    if (this._blocks.has(block.hash)) return { ...result, duplicate: true };
    const parent = this._blocks.get(block.previousHash);
    if (!parent) return { ...result, missingParent: block.previousHash };
    const state = this._validateAndApply(block, parent);
    freezeBlock(block);
    const node = { block, parent, state, chainwork: parent.chainwork + blockWork(block.target) };
    this._blocks.set(block.hash, node);
    const tipChanged = isBetter(node, this._tip);
    if (tipChanged) this._selectTip(node);
    return { ...result, accepted: true, tipChanged };
  }
  getLocator() {
    const result = []; let height = this.chain.length - 1, step = 1;
    while (height > 0) { result.push(this.chain[height].hash); if (result.length >= 10) step *= 2; height = Math.max(0, height - step); }
    result.push(this.genesisHash); return result;
  }
  getBlocksAfter(locator, limit = 16) {
    assert(Array.isArray(locator) && locator.length <= 128 && locator.every(hash => typeof hash === "string" && HASH_PATTERN.test(hash)), "BAD_LOCATOR", "Invalid block locator");
    assert(isSafeInteger(limit, 1) && limit <= 128, "BAD_LIMIT", "Invalid block batch limit");
    const heights = new Map(this.chain.map(block => [block.hash, block.height])); let start = 1;
    for (const hash of locator) if (heights.has(hash)) { start = heights.get(hash) + 1; break; }
    return this.chain.slice(start, start + limit).map(block => block.toJSON());
  }
  exportState() {
    const blocks = Array.from(this._blocks.values()).filter(node => node.parent !== null)
      .sort((a, b) => a.block.height - b.block.height || (a.block.hash < b.block.hash ? -1 : 1)).map(node => node.block.toJSON());
    return { version: VERSION, networkId: this.network.networkId, genesisHash: this.genesisHash, blocks, pendingTransactions: this.pendingTransactions.map(tx => tx.toJSON()) };
  }
  loadState(serialized) {
    const source = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
    onlyFields(source, ["version", "networkId", "genesisHash", "blocks", "pendingTransactions"], "BAD_STATE");
    assert(source.version === VERSION && source.networkId === this.network.networkId && source.genesisHash === this.genesisHash, "BAD_STATE", "Saved state belongs to another network");
    assert(Array.isArray(source.blocks) && Array.isArray(source.pendingTransactions), "BAD_STATE", "Invalid saved state");
    const restored = new Blockchain(this.network);
    for (const raw of [...source.blocks].sort((a, b) => a.height - b.height)) {
      const result = restored.receiveBlock(raw);
      assert(result.accepted && !result.missingParent, "BAD_STATE", "Saved state contains duplicate or disconnected blocks");
    }
    for (const raw of source.pendingTransactions) restored.addTransaction(raw);
    this._blocks = restored._blocks; this._tip = restored._tip; this.chain = restored.chain; this.pendingTransactions = restored.pendingTransactions; return this;
  }
  isChainValid() {
    try {
      const restored = new Blockchain(this.network);
      assert(blockHash(this.chain[0]) === this.genesisHash, "BAD_GENESIS", "Genesis was changed");
      for (const block of this.chain.slice(1)) restored.receiveBlock(block);
      return restored.getLastBlock().hash === this.getLastBlock().hash;
    } catch { return false; }
  }
  async mineBlock(minerAddress, { signal, onProgress } = {}) {
    assert(isAddress(minerAddress), "BAD_ADDRESS", "Invalid miner address");
    if (signal?.aborted) return null;
    const parent = this._tip, state = cloneState(parent.state), selected = []; let fees = 0;
    for (const raw of this.pendingTransactions) {
      if (selected.length >= this.network.maxTransactionsPerBlock) break;
      const tx = normalizeTransaction(raw, this.network); applyTransaction(state, tx); selected.push(tx); fees = safeAdd(fees, tx.feeUnits);
    }
    const timestamp = Math.max(Date.now(), parent.block.timestamp + 1, ...selected.map(tx => tx.timestamp)), height = parent.block.height + 1;
    const reward = Math.min(this.network.blockRewardUnits, this.network.maxSupplyUnits - parent.state.issuedUnits);
    const block = new Block({ version: VERSION, networkId: this.network.networkId, rulesHash: this.rulesHash, height, timestamp,
      previousHash: parent.block.hash, target: this._expectedTarget(parent), nonce: 0,
      transactions: [{ version: VERSION, type: "coinbase", networkId: this.network.networkId, height, to: minerAddress, amountUnits: safeAdd(reward, fees), timestamp }, ...selected] });
    // Nonce is last in the canonical header; avoid repeatedly serializing transactions.
    const prefix = blockSigningBytes(block).toString("utf8").slice(0, -2), numericTarget = targetToBigInt(block.target);
    const started = performance.now(); let lastProgress = started;
    while (true) {
      if (signal?.aborted || this._tip !== parent) return null;
      for (let attempt = 0; attempt < 2048; attempt++) {
        block.hash = crypto.createHash("sha256").update(prefix).update(String(block.nonce)).update("}").digest("hex");
        if (BigInt("0x" + block.hash) <= numericTarget) {
          if (signal?.aborted || this._tip !== parent) return null;
          const result = this.receiveBlock(block); return result.accepted && result.tipChanged ? this.getBlock(block.hash) : null;
        }
        assert(block.nonce < Number.MAX_SAFE_INTEGER, "NONCE_EXHAUSTED", "Block nonce range is exhausted"); block.nonce++;
      }
      const now = performance.now();
      if (onProgress && now - lastProgress >= 250) { const elapsedMs = now - started; onProgress({ nonce: block.nonce, hashrate: block.nonce * 1000 / Math.max(elapsedMs, 1), elapsedMs }); lastProgress = now; }
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}
module.exports = { Transaction, Block, Blockchain, MAX_PENDING_TRANSACTIONS };
