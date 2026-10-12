"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Blockchain, Transaction } = require("../blockchain");
const { Wallet } = require("../wallet");
const { User } = require("../user");
const { ChainStore } = require("../storage");
const { createServer } = require("../server");
const { MAX_PAYLOAD, tipOf } = require("../peer-protocol");
const testnet = require("../networks/testnet.json");

const BLOCK_COUNT = 16;
const TRANSFERS_PER_BLOCK = 100;
const AMOUNT_UNITS = 7;
const FEE_UNITS = 1;
const INITIAL_BALANCE = 1000000;
let historyPromise;

function denseHistory() {
  if (!historyPromise) historyPromise = (async () => {
    const sender = new Wallet("DenseSender").generate();
    const recipient = new Wallet("DenseRecipient").generate();
    const miner = new Wallet("DenseMiner").generate();
    const network = {
      ...JSON.parse(JSON.stringify(testnet)),
      networkId: "dense-sync-" + crypto.randomUUID(),
      initialTarget: "f".repeat(64), maxTarget: "f".repeat(64), adjustmentInterval: 50,
      genesis: { timestamp: Date.now() - 60000, allocations: [{ address: sender.address, amountUnits: INITIAL_BALANCE }] },
    };
    const chain = new Blockchain(network);
    for (let height = 1; height <= BLOCK_COUNT; height++) {
      for (let index = 0; index < TRANSFERS_PER_BLOCK; index++) {
        const nonce = (height - 1) * TRANSFERS_PER_BLOCK + index + 1;
        const transfer = new Transaction({
          networkId: network.networkId, to: recipient.address,
          amountUnits: AMOUNT_UNITS, feeUnits: FEE_UNITS, nonce,
          timestamp: network.genesis.timestamp + nonce,
        }).sign(sender.keys.privateKey);
        chain.addTransaction(transfer);
      }
      const block = await chain.mineBlock(miner.address);
      assert.equal(block.height, height);
      assert.equal(block.transactions.length, TRANSFERS_PER_BLOCK + 1);
      assert.equal(chain.pendingTransactions.length, 0);
    }
    const blocks = chain.getBlocksAfter([chain.genesisHash], BLOCK_COUNT);
    const naiveBytes = Buffer.byteLength(JSON.stringify({
      type: "blocks", from: "archive", to: "fresh-node", requestId: "dense-history", blocks, tip: tipOf(chain),
    }));
    assert.ok(naiveBytes > MAX_PAYLOAD, "Fixture must exceed the transport limit as one sixteen-block response");
    return { sender, recipient, miner, network, chain, naiveBytes };
  })();
  return historyPromise;
}

function fixture(t, history) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-dense-sync-"));
  const users = [], servers = [];
  t.after(async () => {
    const usersClosed = await Promise.allSettled(users.map(user => user.close()));
    const serversClosed = await Promise.allSettled(servers.map(server => server.close()));
    fs.rmSync(directory, { recursive: true, force: true });
    const failures = [...usersClosed, ...serversClosed].filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Dense sync cleanup failed");
  });
  return {
    persist(label) {
      const store = new ChainStore(path.join(directory, label, history.network.networkId));
      store.acquire();
      try { store.save(history.chain); } finally { store.release(); }
    },
    async server(label, archive) {
      const server = await createServer({
        network: history.network, dataDir: path.join(directory, label),
        host: "127.0.0.1", port: 0, downloadPort: null, archive,
      });
      servers.push(server);
      return server;
    },
    async user(wallet, server, label, observe = false) {
      const logs = [], batches = [], errors = [];
      const url = "ws://127.0.0.1:" + server.address.port;
      const user = new User(wallet.name, url, null, {
        wallet, network: history.network, dataDir: path.join(directory, label),
        reconnect: false, connectTimeout: 5000, logger: message => logs.push(String(message)),
      });
      users.push(user);
      const initialized = user.init();
      if (observe) {
        // init opens the WebSocket before yielding; register before the first
        // handshake response so even the first blocks batch is observed.
        assert.ok(user.ws);
        user.ws.on("message", data => {
          const message = JSON.parse(data.toString("utf8"));
          if (message.type === "blocks" && message.blocks?.length) {
            batches.push({ bytes: data.length, count: message.blocks.length, from: message.from });
          }
        });
        user.ws.on("error", error => errors.push(error.message));
      }
      await initialized;
      return { user, batches, errors, logs };
    },
  };
}

async function waitFor(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out: " + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function assertFullySynced(observed, history, expectedSource) {
  const { user, batches, errors, logs } = observed;
  await waitFor(() => (
    user.ready && user.blockchain.getLastBlock().hash === history.chain.getLastBlock().hash
  ) || user.connections.size === 0, "all dense blocks arrive after a byte-limited short response");
  assert.equal(user.blockchain.getLastBlock().height, BLOCK_COUNT, "History stopped early or transport rejected an oversized batch: " + [...errors, ...logs].join("; "));
  assert.equal(user.blockchain.getLastBlock().hash, history.chain.getLastBlock().hash);
  assert.equal(user.blockchain.getChainwork(), history.chain.getChainwork());
  assert.equal(user.ready, true);
  assert.deepEqual(errors, []);
  assert.ok(batches.length >= 2, "Dense history must require more than one transport response");
  assert.ok(batches.some(batch => batch.count < BLOCK_COUNT), "A byte-limited response must contain fewer than sixteen blocks");
  assert.ok(batches.every(batch => batch.bytes <= MAX_PAYLOAD), "A blocks response exceeded MAX_PAYLOAD");
  assert.ok(batches.every(batch => batch.from === expectedSource));
  const transfers = BLOCK_COUNT * TRANSFERS_PER_BLOCK;
  assert.equal(user.blockchain.getConfirmedNonce(history.sender.address), transfers);
  assert.equal(user.blockchain.getBalanceUnits(history.sender.address), INITIAL_BALANCE - transfers * (AMOUNT_UNITS + FEE_UNITS));
  assert.equal(user.blockchain.getBalanceUnits(history.recipient.address), transfers * AMOUNT_UNITS);
  assert.equal(user.blockchain.getBalanceUnits(history.miner.address), BLOCK_COUNT * history.network.blockRewardUnits + transfers * FEE_UNITS);
  assert.equal(user.blockchain.exportState().blocks.length, BLOCK_COUNT);
  assert.equal(user.blockchain.pendingTransactions.length, 0);
}

test("fresh User downloads dense archive history through short payload-limited responses", { timeout: 90000 }, async t => {
  const history = await denseHistory();
  const f = fixture(t, history);
  f.persist("archive");
  const archive = await f.server("archive", true);
  const fresh = await f.user(history.recipient, archive, "fresh", true);
  await assertFullySynced(fresh, history, "archive");
  t.diagnostic(`Naive sixteen-block response: ${history.naiveBytes} bytes; received ${fresh.batches.length} bounded responses`);
});

test("fresh User downloads dense history from a full User through a relay-only server", { timeout: 60000 }, async t => {
  const history = await denseHistory();
  const f = fixture(t, history);
  const relay = await f.server("relay", false);
  f.persist("source");
  const source = await f.user(history.miner, relay, "source");
  await waitFor(() => source.user.ready, "source node ready");
  const sourcePeerId = source.user.connections.get(source.user.serverUrl).id;
  const fresh = await f.user(history.recipient, relay, "fresh", true);
  await assertFullySynced(fresh, history, sourcePeerId);
  assert.equal(relay.ledger, null);
  assert.equal(relay.store, null);
  t.diagnostic(`Full User served ${fresh.batches.length} bounded responses without a server ledger`);
});
