"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { User } = require("../user");
const { Wallet } = require("../wallet");
const { Blockchain } = require("../blockchain");
const { ChainStore } = require("../storage");
const { createServer } = require("../server");
const testnet = require("../networks/testnet.json");

const [aliceWallet, bobWallet, carolWallet] = ["ClientAlice", "ClientBob", "ClientCarol"].map(name => new Wallet(name).generate());
async function waitFor(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out: " + label);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function fixture(t, changes = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-client-test-"));
  const network = { ...JSON.parse(JSON.stringify(testnet)), networkId: "client-" + crypto.randomUUID(),
    initialTarget: "f".repeat(64), maxTarget: "f".repeat(64), adjustmentInterval: 50,
    genesis: { timestamp: Date.now() - 60000, allocations: [{ address: aliceWallet.address, amountUnits: 50000 }] }, ...changes };
  const users = [], servers = [];
  t.after(async () => {
    const userResults = await Promise.allSettled(users.map(user => user.close()));
    const serverResults = await Promise.allSettled(servers.map(server => server.close()));
    fs.rmSync(directory, { recursive: true, force: true });
    const failures = [...userResults, ...serverResults].filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Integration cleanup failed");
  });
  const f = { directory, network, users, servers,
    async server(label = "server", options = {}) {
      const server = await createServer({ network, dataDir: path.join(directory, label), host: "127.0.0.1", port: 0, downloadPort: null, archive: true, ...options });
      servers.push(server); return server;
    },
    url(server) { return "ws://127.0.0.1:" + server.address.port; },
    async user(wallet, server, label, options = {}, initOptions = {}) {
      const user = new User(wallet.name, f.url(server), options.walletPath ?? null, { wallet, network, dataDir: path.join(directory, label), logger: () => {}, reconnect: false, connectTimeout: 2000, ...options });
      users.push(user); await user.init(initOptions); await waitFor(() => user.ready, label + " ready"); return user;
    },
    persist(label, chain) {
      const store = new ChainStore(path.join(directory, label, network.networkId));
      store.acquire(); try { store.save(chain); } finally { store.release(); }
    },
  };
  return f;
}

test("two clients share genesis, propagate pending transfers and confirm balances/nonce", { timeout: 20000 }, async t => {
  const f = fixture(t), server = await f.server();
  const alice = await f.user(aliceWallet, server, "alice"), bob = await f.user(bobWallet, server, "bob");
  assert.equal(alice.blockchain.genesisHash, bob.blockchain.genesisHash);
  assert.equal(alice.blockchain.genesisHash, server.ledger.genesisHash);
  const sent = alice.sendCoins(bobWallet.address, "12.34");
  await waitFor(() => bob.blockchain.pendingTransactions.length === 1 && server.ledger.pendingTransactions.length === 1, "pending transfer reaches peer and archive");
  assert.equal(bob.blockchain.pendingTransactions[0].getId(), sent.id);
  assert.equal(alice.blockchain.getAvailableBalanceUnits(aliceWallet.address), 48765);
  const block = await bob.mine();
  await waitFor(() => alice.blockchain.getLastBlock().hash === block.hash && server.ledger.getLastBlock().hash === block.hash, "mined block reaches peer and archive");
  for (const chain of [alice.blockchain, bob.blockchain, server.ledger]) {
    assert.equal(chain.getBalanceUnits(aliceWallet.address), 48765);
    assert.equal(chain.getBalanceUnits(bobWallet.address), 1335);
    assert.equal(chain.getConfirmedNonce(aliceWallet.address), 1);
    assert.equal(chain.pendingTransactions.length, 0);
    assert.equal(chain.isChainValid(), true);
  }
});

test("fresh client downloads history in batches and restart restores encrypted wallet and chain", { timeout: 20000 }, async t => {
  const f = fixture(t), server = await f.server(), alice = await f.user(aliceWallet, server, "alice");
  alice.sendCoins(bobWallet.address, "1.00");
  let tip;
  for (let i = 0; i < 18; i++) tip = await alice.mine();
  await waitFor(() => server.ledger.getLastBlock().hash === tip.hash, "archive receives eighteen blocks");
  const carol = await f.user(carolWallet, server, "carol");
  assert.equal(carol.blockchain.getLastBlock().hash, tip.hash);
  assert.equal(carol.blockchain.getConfirmedNonce(aliceWallet.address), 1);
  assert.equal(carol.blockchain.getBalanceUnits(bobWallet.address), 100);
  const walletPath = path.join(f.directory, "portable-test.fcwallet"), password = "temporary-test-password";
  aliceWallet.save(password, walletPath);
  const expectedBalance = alice.blockchain.getBalanceUnits(aliceWallet.address);
  await alice.close();
  const restarted = await f.user(aliceWallet, server, "alice", { wallet: null, walletPath }, { password });
  assert.equal(restarted.wallet.address, aliceWallet.address);
  assert.equal(restarted.wallet.keys.publicKey, aliceWallet.keys.publicKey);
  assert.equal(restarted.blockchain.getLastBlock().hash, tip.hash);
  assert.equal(restarted.blockchain.getBalanceUnits(aliceWallet.address), expectedBalance);
  assert.equal(restarted.blockchain.getConfirmedNonce(aliceWallet.address), 1);
});

test("relay-only fresh peer synchronizes from another client without a server ledger", { timeout: 20000 }, async t => {
  const f = fixture(t), server = await f.server("relay", { archive: false }), alice = await f.user(aliceWallet, server, "alice");
  await alice.mine(); const tip = await alice.mine();
  const bob = await f.user(bobWallet, server, "bob");
  assert.equal(server.ledger, null);
  assert.equal(server.store, null);
  assert.equal(fs.existsSync(path.join(f.directory, "relay", f.network.networkId)), false);
  assert.equal(bob.blockchain.getLastBlock().hash, tip.hash);
  assert.equal(bob.blockchain.getBalanceUnits(aliceWallet.address), 50200);
});

test("two relays deduplicate a transaction and block at full nodes", { timeout: 20000 }, async t => {
  const f = fixture(t), first = await f.server("relay-one", { archive: false }), second = await f.server("relay-two", { archive: false });
  const options = { relays: [f.url(second)] };
  const alice = await f.user(aliceWallet, first, "alice", options), bob = await f.user(bobWallet, first, "bob", options);
  await waitFor(() => [...alice.connections.values()].filter(connection => connection.identified).length === 2 && [...bob.connections.values()].filter(connection => connection.identified).length === 2, "both relay connections identified");
  let transactionEvents = 0, blockEvents = 0;
  bob.on("transaction", () => transactionEvents++); bob.on("block", () => blockEvents++);
  alice.sendCoins(bobWallet.address, "25");
  await waitFor(() => bob.blockchain.pendingTransactions.length === 1, "single pending transfer over two relays");
  const block = await alice.mine();
  await waitFor(() => bob.blockchain.getLastBlock().hash === block.hash, "single confirmed block over two relays");
  assert.equal(transactionEvents, 1);
  assert.equal(blockEvents, 1);
  assert.equal(bob.blockchain.getConfirmedNonce(aliceWallet.address), 1);
  assert.equal(bob.blockchain.getBalanceUnits(aliceWallet.address), 47600);
  assert.equal(bob.blockchain.getBalanceUnits(bobWallet.address), 2500);
  assert.equal(bob.blockchain.pendingTransactions.length, 0);
  assert.equal(bob.blockchain.exportState().blocks.length, 1);
});

test("all relay disconnections clear ready and abort active mining", { timeout: 20000 }, async t => {
  const target = "0".repeat(63) + "1";
  const f = fixture(t, { initialTarget: target, maxTarget: target }), server = await f.server(), alice = await f.user(aliceWallet, server, "alice");
  const mining = alice.mine();
  assert.notEqual(alice.mining, null);
  await server.close();
  await waitFor(() => !alice.ready && alice.connections.size === 0, "disconnect clears ready");
  assert.equal(await mining, null);
  assert.equal(alice.mining, null);
  assert.equal(alice.blockchain.chain.length, 1);
  assert.equal(alice.retries.size, 0);
  assert.throws(() => alice.sendCoins(bobWallet.address, "1"), /Подождите/);
});

test("client reconnects to the same port and server restores checked archive history", { timeout: 20000 }, async t => {
  const f = fixture(t), original = await f.server(), alice = await f.user(aliceWallet, original, "alice", { reconnect: true });
  const block = await alice.mine();
  await waitFor(() => original.ledger.getLastBlock().hash === block.hash, "archive persists confirmed block");
  const port = original.address.port;
  await original.close();
  await waitFor(() => !alice.ready, "client notices stopped server");
  const restarted = await f.server("server", { port });
  assert.equal(restarted.ledger.getLastBlock().hash, block.hash);
  await waitFor(() => alice.ready && [...alice.connections.values()].some(connection => connection.identified), "client reconnects to restarted archive", 8000);
  assert.equal(alice.blockchain.getLastBlock().hash, block.hash);
  assert.equal(restarted.ledger.getBalanceUnits(aliceWallet.address), 50100);
});

test("an invalid block from the transport cannot mutate a full node", { timeout: 20000 }, async t => {
  const f = fixture(t), server = await f.server(), alice = await f.user(aliceWallet, server, "alice");
  const logs = [], bob = await f.user(bobWallet, server, "bob", { logger: message => logs.push(message) });
  const block = await alice.mine();
  await waitFor(() => bob.blockchain.getLastBlock().hash === block.hash && server.ledger.getLastBlock().hash === block.hash, "baseline block confirmed");
  const before = JSON.stringify(bob.blockchain.exportState()), balance = bob.blockchain.getBalanceUnits(aliceWallet.address);
  const invalid = { ...block.toJSON(), hash: "0".repeat(64) };
  for (const socket of server.wss.clients) socket.send(JSON.stringify({ type: "block", from: "archive", block: invalid }));
  await waitFor(() => logs.some(message => message.startsWith("Отклонено сообщение:")), "node rejects invalid transport block");
  assert.equal(JSON.stringify(bob.blockchain.exportState()), before);
  assert.equal(bob.blockchain.getBalanceUnits(aliceWallet.address), balance);
  assert.equal(bob.ready, true);
});

test("client guards concurrent mining and releases store on close", { timeout: 20000 }, async t => {
  const f = fixture(t), server = await f.server(), alice = await f.user(aliceWallet, server, "alice");
  const mining = alice.mine();
  await assert.rejects(alice.mine(), /уже запущен/);
  const block = await mining;
  assert.equal(block.height, 1);
  assert.equal(alice.mining, null);
  const lockfile = alice.store.lockfile;
  await alice.close();
  assert.equal(fs.existsSync(lockfile), false);
  const restarted = await f.user(aliceWallet, server, "alice");
  assert.equal(restarted.blockchain.getLastBlock().hash, block.hash);
});
test("closing during active mining permits safe restart of the same store", { timeout: 20000 }, async t => {
  const target = "0".repeat(63) + "1";
  const f = fixture(t, { initialTarget: target, maxTarget: target }), server = await f.server(), alice = await f.user(aliceWallet, server, "alice");
  const lockfile = alice.store.lockfile, mining = alice.mine();
  assert.notEqual(alice.mining, null);
  await alice.close();
  assert.equal(await mining, null);
  assert.equal(alice.mining, null);
  assert.equal(fs.existsSync(lockfile), false);
  const restarted = await f.user(aliceWallet, server, "alice");
  assert.equal(restarted.blockchain.getLastBlock().height, 0);
  assert.equal(restarted.blockchain.getBalanceUnits(aliceWallet.address), 50000);
});

test("fork sync continues beyond sixteen blocks before its chainwork wins", { timeout: 20000 }, async t => {
  const f = fixture(t), server = await f.server("relay", { archive: false });
  const localChain = new Blockchain(f.network), remoteChain = new Blockchain(f.network);
  for (let i = 0; i < 17; i++) await localChain.mineBlock(aliceWallet.address);
  for (let i = 0; i < 18; i++) await remoteChain.mineBlock(bobWallet.address);
  f.persist("local", localChain); f.persist("remote", remoteChain);
  const remote = await f.user(bobWallet, server, "remote");
  assert.equal(remote.blockchain.getLastBlock().hash, remoteChain.getLastBlock().hash);
  const local = await f.user(aliceWallet, server, "local");
  await waitFor(() => local.blockchain.getLastBlock().hash === remoteChain.getLastBlock().hash, "fork second batch overtakes local seventeen-block chain");
  assert.equal(local.blockchain.getLastBlock().height, 18);
  assert.equal(local.blockchain.hasBlock(remoteChain.chain[16].hash), true);
  assert.equal(local.blockchain.hasBlock(localChain.getLastBlock().hash), true);
  assert.equal(local.blockchain.getChainwork(), remote.blockchain.getChainwork());
});
