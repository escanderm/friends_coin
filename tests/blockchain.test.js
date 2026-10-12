"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Transaction, Block, Blockchain, MAX_PENDING_TRANSACTIONS } = require("../blockchain");
const { addressFromPublicKey, canonicalPublicKey, isAddress, parseAmountUnits, formatAmountUnits, hashMeetsTarget, targetToBigInt, targetToHex, blockWork, MAX_FUTURE_MS } = require("../protocol");

const keys = Array.from({ length: 3 }, () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }));
const [A, B, C] = keys.map(pair => ({ ...pair, address: addressFromPublicKey(pair.publicKey), publicPem: canonicalPublicKey(pair.publicKey) }));
const GENESIS_TIME = 1700000000000;
const EASY_TARGET = "7" + "f".repeat(63);
function network(changes = {}) {
  return { networkId: "core-test-v2", protocolVersion: 2, decimals: 2, blockRewardUnits: 100,
    maxSupplyUnits: 100000, minFeeUnits: 1, maxTransactionsPerBlock: 100,
    targetBlockTime: 600, adjustmentInterval: 50, initialTarget: EASY_TARGET, maxTarget: EASY_TARGET,
    genesis: { timestamp: GENESIS_TIME, allocations: [{ address: A.address, amountUnits: 10000 }] }, ...changes };
}
function transfer({ sender = A, to = B.address, amountUnits = 100, feeUnits = 1, nonce = 1, timestamp = GENESIS_TIME + 1, networkId = "core-test-v2" } = {}) {
  return new Transaction({ networkId, to, amountUnits, feeUnits, nonce, timestamp }).sign(sender.privateKey);
}
function seal(block) {
  while (true) { block.hash = block.calculateHash(); if (hashMeetsTarget(block.hash, block.target)) return block.toJSON(); block.nonce++; }
}
function candidate(chain, { transactions = [], timestamp = Math.max(Date.now(), chain.getLastBlock().timestamp + 1), miner = C.address, target = chain.getNextTarget(), reward } = {}) {
  const height = chain.getLastBlock().height + 1;
  const fees = transactions.reduce((sum, tx) => sum + tx.feeUnits, 0);
  return new Block({ version: 2, networkId: chain.network.networkId, rulesHash: chain.rulesHash, height, timestamp,
    previousHash: chain.getLastBlock().hash, target, nonce: 0,
    transactions: [{ version: 2, type: "coinbase", networkId: chain.network.networkId, height, to: miner,
      amountUnits: reward ?? Math.min(chain.network.blockRewardUnits, chain.network.maxSupplyUnits - chain.getIssuedUnits()) + fees, timestamp }, ...transactions.map(tx => typeof tx.toJSON === "function" ? tx.toJSON() : tx)] });
}
function append(chain, options) { const raw = seal(candidate(chain, options)); assert.equal(chain.receiveBlock(raw).accepted, true); return raw; }
function errorCode(code) { return error => error.code === code; }

test("addresses use canonical SPKI and a verified checksum", () => {
  assert.equal(isAddress(A.address), true);
  assert.equal(addressFromPublicKey(A.publicPem), A.address);
  assert.equal(isAddress(A.address.slice(0, -1) + (A.address.endsWith("0") ? "1" : "0")), false);
  assert.equal(isAddress(A.publicPem), false);
});
test("coin parsing preserves hundredths and rejects precision loss", () => {
  assert.equal(parseAmountUnits("0.01"), 1);
  assert.equal(parseAmountUnits("123.45"), 12345);
  assert.equal(formatAmountUnits(12345), "123.45");
  for (const amount of ["-1", "NaN", "Infinity", "1e3", "1.001", "90071992547409.92"]) assert.throws(() => parseAmountUnits(amount));
});
test("genesis is deterministic and commits all network rules and allocations", () => {
  const config = network();
  const first = new Blockchain(config), second = new Blockchain(JSON.parse(JSON.stringify(config)));
  assert.equal(first.genesisHash, second.genesisHash);
  assert.equal(first.getBalanceUnits(A.address), 10000);
  assert.notEqual(new Blockchain(network({ blockRewardUnits: 101 })).genesisHash, first.genesisHash);
  assert.notEqual(new Blockchain(network({ networkId: "different-network" })).genesisHash, first.genesisHash);
  assert.throws(() => new Blockchain(network({ genesis: { timestamp: GENESIS_TIME, allocations: [{ address: "Alice", amountUnits: 1000 }] } })), errorCode("BAD_NETWORK_CONFIG"));
  assert.throws(() => { first.chain[0].transactions[0].amountUnits = 99999999; }, TypeError);
});
test("signature binds every field and repairs no mismatched sender", () => {
  const tx = transfer();
  assert.equal(tx.isValid(), true);
  assert.equal(new Transaction(JSON.parse(JSON.stringify(tx))).getId(), tx.getId());
  const amountChanged = new Transaction({ ...tx.toJSON(), amountUnits: 101 });
  assert.equal(amountChanged.isValid(), false);
  const networkChanged = new Transaction({ ...tx.toJSON(), networkId: "another-network" });
  assert.equal(networkChanged.isValid(), false);
  assert.throws(() => new Transaction({ ...tx.toJSON(), from: B.address }).sign(A.privateKey), errorCode("BAD_SENDER"));
  assert.equal(transfer().from, A.address);
});
test("old amount/timestamp concatenation ambiguity cannot retain a signature", () => {
  const original = transfer({ amountUnits: 1, timestamp: 1700000000000 });
  const altered = new Transaction({ ...original.toJSON(), amountUnits: 11, timestamp: 700000000000 });
  assert.notEqual(altered.getHash(), original.getHash());
  assert.equal(altered.isValid(), false);
});
test("negative, zero, fractional and unsafe amounts are rejected", () => {
  for (const amountUnits of [-100, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100"]) assert.throws(() => transfer({ amountUnits }), errorCode("BAD_AMOUNT"));
  assert.throws(() => transfer({ amountUnits: Number.MAX_SAFE_INTEGER, feeUnits: 1 }), errorCode("UNSAFE_AMOUNT"));
  assert.throws(() => transfer({ nonce: 0 }), errorCode("BAD_NONCE"));
});
test("pool reserves fees and nonce, rejects double spends and replay", async () => {
  const chain = new Blockchain(network());
  const tx = transfer({ amountUnits: 6000 }); chain.addTransaction(tx);
  assert.equal(chain.getBalanceUnits(A.address), 10000);
  assert.equal(chain.getAvailableBalanceUnits(A.address), 3999);
  assert.equal(chain.getNextNonce(A.address), 2);
  assert.throws(() => chain.addTransaction(tx), errorCode("DUPLICATE_TRANSACTION"));
  assert.throws(() => chain.addTransaction(transfer({ amountUnits: 5000, nonce: 2 })), errorCode("INSUFFICIENT_FUNDS"));
  assert.throws(() => chain.addTransaction(transfer({ amountUnits: 1, nonce: 1 })), errorCode("BAD_NONCE"));
  const mined = await chain.mineBlock(C.address);
  assert.equal(mined.height, 1);
  assert.equal(chain.pendingTransactions.length, 0);
  assert.equal(chain.getBalanceUnits(A.address), 3999);
  assert.equal(chain.getBalanceUnits(B.address), 6000);
  assert.equal(chain.getBalanceUnits(C.address), 101);
  assert.equal(chain.getIssuedUnits(), 10100);
  assert.throws(() => chain.addTransaction(tx), errorCode("BAD_NONCE"));
});
test("network ID, minimum fee and unauthorized mint are enforced", () => {
  const chain = new Blockchain(network());
  assert.throws(() => chain.addTransaction(transfer({ networkId: "another-network" })), errorCode("BAD_NETWORK"));
  assert.throws(() => chain.addTransaction(transfer({ feeUnits: 0 })), errorCode("FEE_TOO_LOW"));
  assert.throws(() => chain.addTransaction({ from: "SYSTEM", to: B.address, amountUnits: 999999 }), errorCode("BAD_VERSION"));
});
test("PoW, exact reward and one coinbase are required before accepting a block", () => {
  const chain = new Blockchain(network());
  const noWork = candidate(chain);
  do { noWork.nonce++; noWork.hash = noWork.calculateHash(); } while (hashMeetsTarget(noWork.hash, noWork.target));
  assert.throws(() => chain.receiveBlock(noWork), errorCode("BAD_POW"));
  assert.throws(() => chain.receiveBlock(seal(candidate(chain, { reward: 100000 }))), errorCode("BAD_COINBASE"));
  const duplicateCoinbase = candidate(chain); duplicateCoinbase.transactions.push({ ...duplicateCoinbase.transactions[0] });
  assert.throws(() => chain.receiveBlock(seal(duplicateCoinbase)), errorCode("BAD_TRANSACTION"));
  const corrupted = seal(candidate(chain)); corrupted.transactions[0].amountUnits++;
  assert.throws(() => chain.receiveBlock(corrupted), errorCode("BAD_HASH"));
  assert.equal(chain.chain.length, 1);
});
test("height, time, declared target, sender nonce and balance are checked in blocks", () => {
  const config = network({ maxTarget: "f".repeat(64) }), chain = new Blockchain(config);
  const height = candidate(chain); height.height++; height.transactions[0].height++;
  assert.throws(() => chain.receiveBlock(seal(height)), errorCode("BAD_HEIGHT"));
  assert.throws(() => chain.receiveBlock(seal(candidate(chain, { timestamp: GENESIS_TIME }))), errorCode("BAD_TIMESTAMP"));
  assert.throws(() => chain.receiveBlock(seal(candidate(chain, { timestamp: Date.now() + MAX_FUTURE_MS + 60000 }))), errorCode("BAD_TIMESTAMP"));
  assert.throws(() => chain.receiveBlock(seal(candidate(chain, { target: config.maxTarget }))), errorCode("BAD_TARGET"));
  assert.throws(() => chain.receiveBlock(seal(candidate(chain, { transactions: [transfer({ amountUnits: 10000 })] }))), errorCode("INSUFFICIENT_FUNDS"));
  assert.throws(() => chain.receiveBlock(seal(candidate(chain, { transactions: [transfer(), transfer({ amountUnits: 200 })] }))), errorCode("BAD_NONCE"));
});
test("issuance stops at cap and fees still reach miners", () => {
  const chain = new Blockchain(network({ maxSupplyUnits: 10050 }));
  const first = append(chain); assert.equal(first.transactions[0].amountUnits, 50);
  assert.equal(chain.getIssuedUnits(), 10050);
  const second = append(chain, { transactions: [transfer()] });
  assert.equal(second.transactions[0].amountUnits, 1);
  assert.equal(chain.getIssuedUnits(), 10050);
  assert.equal(chain.getBalanceUnits(C.address), 51);
});
test("missing parents and duplicates return compact sync results", () => {
  const source = new Blockchain(network()), receiver = new Blockchain(network());
  const first = append(source), second = append(source);
  assert.equal(receiver.receiveBlock(second).missingParent, first.hash);
  assert.equal(receiver.chain.length, 1);
  assert.equal(receiver.receiveBlock(first).accepted, true);
  assert.equal(receiver.receiveBlock(first).duplicate, true);
  assert.equal(receiver.receiveBlock(second).accepted, true);
});
test("wire object key order does not change canonical hashes", () => {
  const config = network(), source = new Blockchain(config), receiver = new Blockchain(config);
  const raw = append(source, { transactions: [transfer()] });
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  reordered.transactions = reordered.transactions.map(tx => Object.fromEntries(Object.entries(tx).reverse()));
  assert.equal(new Block(reordered).calculateHash(), raw.hash);
  assert.equal(receiver.receiveBlock(reordered).accepted, true);
});
test("reorg returns detached transfers and preserves nonce dependencies", () => {
  const config = network(), local = new Blockchain(config), alternative = new Blockchain(config);
  const firstTx = transfer(), nextTx = transfer({ nonce: 2, amountUnits: 200 });
  append(local, { transactions: [firstTx] }); local.addTransaction(nextTx);
  const first = append(alternative, { miner: B.address }), second = append(alternative, { miner: B.address });
  local.receiveBlock(first); local.receiveBlock(second);
  assert.equal(local.getLastBlock().hash, second.hash);
  assert.equal(local.getBalanceUnits(A.address), 10000);
  assert.deepEqual(local.pendingTransactions.map(tx => tx.nonce), [1, 2]);
  assert.equal(local.getNextNonce(A.address), 3);
  assert.equal(local.getAvailableBalanceUnits(A.address), 9698);
});
test("reorg drops a detached transfer when the winning branch spent its nonce", () => {
  const config = network(), local = new Blockchain(config), alternative = new Blockchain(config);
  append(local, { transactions: [transfer()] });
  const conflicting = transfer({ to: C.address, amountUnits: 700 });
  const first = append(alternative, { transactions: [conflicting], miner: B.address }), second = append(alternative, { miner: B.address });
  local.receiveBlock(first); local.receiveBlock(second);
  assert.equal(local.pendingTransactions.length, 0);
  assert.equal(local.getBalanceUnits(A.address), 9299);
  assert.equal(local.getConfirmedNonce(A.address), 1);
});
test("retarget uses a complete interval, clamps changes and chainwork wins over length", () => {
  const start = Date.now() - 120000, initial = "3" + "f".repeat(63);
  const config = network({ initialTarget: initial, maxTarget: "f".repeat(64), adjustmentInterval: 2, targetBlockTime: 10,
    genesis: { timestamp: start, allocations: [{ address: A.address, amountUnits: 10000 }] } });
  const slow = new Blockchain(config), fast = new Blockchain(config);
  append(slow, { timestamp: start + 40000 }); append(slow, { timestamp: start + 80000 });
  assert.equal(slow.getNextTarget(), targetToHex(targetToBigInt(initial) * 4n));
  append(slow, { timestamp: start + 90000 }); append(slow, { timestamp: start + 100000 });
  const f1 = append(fast, { timestamp: start + 1000 }), f2 = append(fast, { timestamp: start + 2000 });
  assert.equal(fast.getNextTarget(), targetToHex(targetToBigInt(initial) / 4n));
  const f3 = append(fast, { timestamp: start + 3000 });
  assert.ok(BigInt(fast.getChainwork()) > BigInt(slow.getChainwork()));
  assert.equal(BigInt(fast.getChainwork()), blockWork(initial) * 2n + blockWork(f3.target));
  slow.receiveBlock(f1); slow.receiveBlock(f2); slow.receiveBlock(f3);
  assert.equal(slow.getLastBlock().hash, f3.hash);
  assert.equal(slow.getLastBlock().height, 3);
});
test("saved forks and pool reload through validation; corrupted state is atomic", () => {
  const config = network(), local = new Blockchain(config), other = new Blockchain(config);
  append(local); local.receiveBlock(append(other, { miner: B.address })); local.addTransaction(transfer());
  const exported = local.exportState(), restored = new Blockchain(config).loadState(JSON.stringify(exported));
  assert.equal(restored.getLastBlock().hash, local.getLastBlock().hash);
  assert.equal(restored.getChainwork(), local.getChainwork());
  assert.equal(restored.pendingTransactions[0].getId(), local.pendingTransactions[0].getId());
  assert.equal(restored.exportState().blocks.length, 2);
  exported.blocks[0].transactions[0].amountUnits++;
  assert.throws(() => restored.loadState(exported), errorCode("BAD_HASH"));
  assert.equal(restored.getLastBlock().hash, local.getLastBlock().hash);
  assert.equal(restored.isChainValid(), true);
});
test("locators request missing canonical blocks in bounded batches", () => {
  const source = new Blockchain(network()), target = new Blockchain(network());
  const first = append(source); append(source); append(source);
  assert.deepEqual(source.getBlocksAfter(target.getLocator(), 2).map(block => block.height), [1, 2]);
  target.receiveBlock(first);
  assert.deepEqual(source.getBlocksAfter(target.getLocator()).map(block => block.height), [2, 3]);
  assert.equal(source.getLocator().at(-1), source.genesisHash);
});
test("mining yields to cancellation", async () => {
  const target = "00000000" + "f".repeat(56);
  const config = network({ initialTarget: target, maxTarget: target });
  const chain = new Blockchain(config), abort = new AbortController();
  const mining = chain.mineBlock(C.address, { signal: abort.signal });
  setImmediate(() => abort.abort());
  assert.equal(await mining, null);
  assert.equal(chain.chain.length, 1);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  assert.equal(await chain.mineBlock(C.address, { signal: alreadyAborted.signal }), null);
});
test("mining abandons its candidate after receiving another valid tip", async () => {
  const target = "0000" + "f".repeat(60);
  const chain = new Blockchain(network({ initialTarget: target, maxTarget: target }));
  let timestamp = Date.now();
  // Select a deterministic candidate that cannot finish before its first yield.
  while (true) {
    const check = candidate(chain, { timestamp, miner: C.address });
    let early = false;
    for (let nonce = 0; nonce < 2048; nonce++) {
      check.nonce = nonce;
      if (hashMeetsTarget(check.calculateHash(), target)) { early = true; break; }
    }
    if (!early) break;
    timestamp++;
  }
  const competing = seal(candidate(chain, { timestamp, miner: B.address }));
  const originalNow = Date.now;
  try {
    Date.now = () => timestamp;
    const mining = chain.mineBlock(C.address);
    process.nextTick(() => chain.receiveBlock(competing));
    assert.equal(await mining, null);
    assert.equal(chain.getLastBlock().hash, competing.hash);
    assert.equal(chain.chain.length, 2);
  } finally { Date.now = originalNow; }
});
test("reorg and admission bound the pool, and mining permits omitted transfers again", async () => {
  const config = network(), local = new Blockchain(config), alternative = new Blockchain(config);
  const transactions = [];
  for (let nonce = 1; nonce <= MAX_PENDING_TRANSACTIONS + 1; nonce++) transactions.push(transfer({ amountUnits: 1, nonce }));
  for (let offset = 0; offset < transactions.length; offset += 100) append(local, { transactions: transactions.slice(offset, offset + 100) });
  for (let i = 0; i < 12; i++) append(alternative, { miner: B.address });
  for (const block of alternative.chain.slice(1)) local.receiveBlock(block);
  assert.equal(local.pendingTransactions.length, MAX_PENDING_TRANSACTIONS);
  assert.equal(local.getNextNonce(A.address), MAX_PENDING_TRANSACTIONS + 1);
  assert.throws(() => local.addTransaction(transactions.at(-1)), errorCode("POOL_FULL"));
  await local.mineBlock(C.address);
  assert.equal(local.pendingTransactions.length, MAX_PENDING_TRANSACTIONS - 100);
  local.addTransaction(transactions.at(-1));
  assert.equal(local.pendingTransactions.length, MAX_PENDING_TRANSACTIONS - 99);
  assert.equal(local.getNextNonce(A.address), MAX_PENDING_TRANSACTIONS + 2);
});
