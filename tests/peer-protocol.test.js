"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Transaction, Block, Blockchain } = require("../blockchain");
const { addressFromPublicKey } = require("../protocol");
const { MAX_PAYLOAD, boundedBlocksMessage, parseMessage, validatePeerMessage, tipOf } = require("../peer-protocol");
const testnet = require("../networks/testnet.json");

const sender = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const receiver = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const senderAddress = addressFromPublicKey(sender.publicKey), receiverAddress = addressFromPublicKey(receiver.publicKey);
function signedBlocks(count, transactionCount = 100) {
  const network = { ...JSON.parse(JSON.stringify(testnet)), networkId: "peer-byte-test-" + transactionCount,
    maxTransactionsPerBlock: Math.max(100, transactionCount), adjustmentInterval: 50,
    initialTarget: "f".repeat(64), maxTarget: "f".repeat(64),
    genesis: { timestamp: Date.now() - 60000, allocations: [{ address: senderAddress, amountUnits: 50000 }] } };
  const chain = new Blockchain(network), blocks = [];
  let nonce = 1;
  for (let height = 1; height <= count; height++) {
    const timestamp = network.genesis.timestamp + height * 1000;
    const transfers = Array.from({ length: transactionCount }, () => new Transaction({
      networkId: network.networkId, to: receiverAddress, amountUnits: 1, feeUnits: 1, nonce: nonce++, timestamp,
    }).sign(sender.privateKey).toJSON());
    const block = new Block({ version: 2, networkId: network.networkId, rulesHash: chain.rulesHash,
      height, timestamp, previousHash: chain.getLastBlock().hash, target: chain.getNextTarget(), nonce: 0,
      transactions: [{ version: 2, type: "coinbase", networkId: network.networkId, height, to: senderAddress,
        amountUnits: network.blockRewardUnits + transactionCount, timestamp }, ...transfers] });
    assert.equal(chain.receiveBlock(block).accepted, true);
    blocks.push(block.toJSON());
  }
  return { chain, blocks };
}
function size(message) { return Buffer.byteLength(JSON.stringify(message), "utf8"); }

test("signed full-block responses truncate to the maximal contiguous byte-bounded prefix", () => {
  const { chain, blocks } = signedBlocks(16);
  const fields = { type: "pool", to: crypto.randomUUID(), requestId: "sync-real-blocks", tip: tipOf(chain) };
  assert.ok(size({ ...fields, type: "blocks", blocks }) > MAX_PAYLOAD);
  const response = boundedBlocksMessage(fields, blocks);
  assert.equal(response.type, "blocks");
  assert.equal(fields.type, "pool");
  assert.ok(response.blocks.length > 0 && response.blocks.length < 16);
  assert.deepEqual(response.blocks, blocks.slice(0, response.blocks.length));
  assert.ok(size(response) <= MAX_PAYLOAD - 256);
  assert.ok(size({ ...response, blocks: blocks.slice(0, response.blocks.length + 1) }) > MAX_PAYLOAD - 256);
  for (const [index, block] of response.blocks.entries()) {
    assert.equal(block.height, index + 1);
    assert.equal(block.transactions.length, 101);
    assert.equal(block.previousHash, index ? response.blocks[index - 1].hash : chain.genesisHash);
  }
  const forwarded = { ...response, from: crypto.randomUUID() };
  assert.ok(size(forwarded) <= MAX_PAYLOAD);
  assert.equal(validatePeerMessage(parseMessage(Buffer.from(JSON.stringify(forwarded)))).type, "blocks");
  assert.equal(blocks.length, 16);
});

test("small valid blocks retain the sixteen-block count limit and empty responses", () => {
  const { chain, blocks } = signedBlocks(17, 0);
  const fields = { requestId: "small-blocks", tip: tipOf(chain) };
  const response = boundedBlocksMessage(fields, blocks);
  assert.equal(response.blocks.length, 16);
  assert.deepEqual(response.blocks.map(block => block.height), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.ok(size(response) < MAX_PAYLOAD - 256);
  assert.deepEqual(boundedBlocksMessage(fields, []), { ...fields, type: "blocks", blocks: [] });
});

test("a genuinely oversized signed first block raises an explicit sync error", () => {
  const { chain, blocks } = signedBlocks(1, 1000);
  assert.equal(blocks[0].transactions.length, 1001);
  assert.ok(size(blocks[0]) > MAX_PAYLOAD - 256);
  assert.throws(() => boundedBlocksMessage({ requestId: "oversized", tip: tipOf(chain) }, blocks), error => error.code === "BLOCK_TOO_LARGE");
});
