const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const WebSocket = require("ws");
const { Wallet } = require("../wallet");
const { Blockchain, Transaction } = require("../blockchain");
const { validateNetwork } = require("../protocol");
const { signIdentity, verifyIdentity, tipOf, MAX_PAYLOAD } = require("../peer-protocol");
const { createServer, SERVER_VERSION, RELEASES_URL } = require("../server");
let alice, bob;
test.before(() => { alice = new Wallet("Alice").generate(); bob = new Wallet("Bob").generate(); });

function makeNetwork() {
  return validateNetwork({ networkId: "server-test-" + Math.random().toString(16).slice(2), protocolVersion: 2,
    decimals: 2, blockRewardUnits: 100, maxSupplyUnits: 10000000, minFeeUnits: 1,
    maxTransactionsPerBlock: 10, targetBlockTime: 10, adjustmentInterval: 10,
    initialTarget: "f".repeat(64), maxTarget: "f".repeat(64),
    genesis: { timestamp: Date.now() - 10000, allocations: [{ address: alice.address, amountUnits: 10000 }] } });
}
class Peer {
  constructor(instance, network) {
    this.local = new Blockchain(network); this.network = network; this.messages = []; this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${instance.address.port}`);
    this.closed = new Promise(resolve => this.ws.once("close", (code) => resolve(code)));
    this.ws.on("error", () => {});
    this.ws.on("message", data => {
      const message = JSON.parse(data.toString());
      if (this.autoPool && message.type === "request_pool" && message.from === "archive") {
        this.send({ type: "pool", to: "archive", requestId: message.requestId, transactions: [] });
      }
      const index = this.waiters.findIndex(waiter => waiter.test(message));
      if (index >= 0) { const waiter = this.waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
      else this.messages.push(message);
    });
  }
  async open() { if (this.ws.readyState !== WebSocket.OPEN) await new Promise((resolve, reject) => { this.ws.once("open", resolve); this.ws.once("error", reject); }); return this; }
  send(message) { this.ws.send(JSON.stringify(message)); }
  wait(type, predicate = () => true) {
    const matches = message => message.type === type && predicate(message);
    const index = this.messages.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { test: matches, resolve, timer: setTimeout(() => {
        const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for " + type));
      }, 3000) };
      this.waiters.push(waiter);
    });
  }
  hello(overrides = {}) { this.send({ type: "hello", protocolVersion: 2, networkId: this.network.networkId, genesisHash: this.local.genesisHash, clientVersion: "unrelated-app-version", ...overrides }); }
  async identify(wallet, options = {}) {
    this.autoPool = options.autoPool !== false;
    this.hello(options.hello || {});
    const welcome = await this.wait("welcome"); this.welcome = welcome; this.id = welcome.peerId;
    this.send({ type: "identify", identity: signIdentity(wallet, this.network.networkId, welcome.challenge) });
    this.identified = await this.wait("identified");
    return this;
  }
}
async function setup(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-server-test-")));
  const network = options.network || makeNetwork(); const instances = []; const peers = [];
  t.after(async () => {
    for (const peer of peers) peer.ws.terminate();
    for (const instance of instances) await instance.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const start = async (overrides = {}) => {
    const instance = await createServer({ network, dataDir: directory, port: 0, ...options, ...overrides });
    instances.push(instance); return instance;
  };
  const instance = await start();
  const connect = async (wallet, connectOptions) => {
    const peer = new Peer(instance, network); peers.push(peer); await peer.open();
    if (wallet) await peer.identify(wallet, connectOptions);
    return peer;
  };
  return { directory, network, instance, start, connect, peers };
}
function transfer(network) {
  return alice.signTransaction(new Transaction({ networkId: network.networkId, from: alice.address,
    to: bob.address, amountUnits: 500, feeUnits: 1, nonce: 1, timestamp: Date.now() }));
}

test("protocol hello and signed identity work independently of application version", async t => {
  const { connect, network } = await setup(t);
  const peer = await connect(alice);
  assert.equal(peer.welcome.protocolVersion, 2);
  assert.equal(peer.welcome.serverVersion, SERVER_VERSION);
  assert.match(peer.welcome.challenge, /^[0-9a-f]{64}$/);
  const own = peer.identified.peers.find(entry => entry.id === peer.id);
  assert.equal(verifyIdentity(own.identity, network.networkId, own.challenge), true);
  assert.ok(peer.identified.peers.some(entry => entry.id === "archive" && entry.archive));
});

test("wrong protocol, network, genesis and out-of-phase messages disconnect only the sender", async t => {
  const { connect } = await setup(t, { archive: false });
  for (const override of [{ protocolVersion: 1 }, { networkId: "wrong-net" }, { genesisHash: "0".repeat(64) }, { type: "transaction" }]) {
    const peer = await connect(); peer.hello(override);
    assert.equal((await peer.wait("error")).code, "PROTOCOL_ERROR");
    assert.equal(await peer.closed, 1008);
  }
  const good = await connect(alice);
  assert.equal(good.ws.readyState, WebSocket.OPEN);
});

test("identity cannot be forged with a name, mismatched key or reused challenge", async t => {
  const { connect, network } = await setup(t, { archive: false });
  const peer = await connect(); peer.hello(); const welcome = await peer.wait("welcome");
  const identity = signIdentity(alice, network.networkId, welcome.challenge);
  identity.signature = signIdentity(bob, network.networkId, welcome.challenge).signature;
  peer.send({ type: "identify", identity });
  assert.equal(await peer.closed, 1008);
  const replay = await connect(); replay.hello(); await replay.wait("welcome");
  replay.send({ type: "identify", identity: signIdentity(alice, network.networkId, welcome.challenge) });
  assert.equal(await replay.closed, 1008);
  await connect(alice);
});

test("malformed JSON, malformed requests and oversized frames do not crash server", async t => {
  const { connect } = await setup(t, { archive: false });
  const malformed = await connect(alice); malformed.ws.send("{broken");
  assert.equal(await malformed.closed, 1008);
  const request = await connect(alice);
  request.send({ type: "request_blocks", to: "archive", requestId: "bad", locator: [], limit: 17 });
  assert.equal(await request.closed, 1008);
  const huge = await connect(alice); huge.ws.send("x".repeat(MAX_PAYLOAD + 1));
  assert.equal(await huge.closed, 1009);
  const healthy = await connect(bob);
  assert.equal(healthy.ws.readyState, WebSocket.OPEN);
});

test("relay stamps sender, routes directed responses and writes no ledger in relay-only mode", async t => {
  const { connect, directory, network, instance } = await setup(t, { archive: false });
  const sender = await connect(alice), recipient = await connect(bob);
  sender.send({ type: "transaction", transaction: transfer(network) });
  const received = await recipient.wait("transaction");
  assert.equal(received.from, sender.id);
  sender.send({ type: "request_pool", to: recipient.id, requestId: "directed" });
  assert.equal((await recipient.wait("request_pool", message => message.requestId === "directed")).from, sender.id);
  recipient.send({ type: "pool", to: sender.id, requestId: "directed", transactions: [] });
  assert.equal((await sender.wait("pool")).from, recipient.id);
  assert.equal(instance.ledger, null); assert.equal(instance.store, null);
  assert.deepEqual(fs.readdirSync(directory), []);
  sender.send({ type: "admin_mint", amount: 100000 });
  assert.equal(await sender.closed, 1008);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("spoofed sender and invalid signature are rejected without updating archive", async t => {
  const { connect, network, instance } = await setup(t);
  const recipient = await connect(bob), attacker = await connect(alice);
  attacker.send({ type: "transaction", from: recipient.id, transaction: transfer(network) });
  assert.equal(await attacker.closed, 1008);
  assert.equal(instance.ledger.pendingTransactions.length, 0);
  const invalid = await connect(alice); const tx = transfer(network).toJSON(); tx.amountUnits += 1;
  invalid.send({ type: "transaction", transaction: tx });
  assert.equal(await invalid.closed, 1008);
  assert.equal(instance.ledger.pendingTransactions.length, 0);
  recipient.send({ type: "request_blocks", to: "archive", requestId: "still-alive", locator: [instance.ledger.genesisHash], limit: 16 });
  assert.deepEqual((await recipient.wait("blocks")).blocks, []);
});

test("message and byte rate limits disconnect flooding peers", async t => {
  const { connect } = await setup(t, { archive: false });
  const fast = await connect(alice);
  for (let i = 0; i < 110; i++) fast.send({ type: "announce", tip: tipOf(fast.local) });
  assert.equal(await fast.closed, 1008);
  const bulky = await connect(bob);
  for (let i = 0; i < 6; i++) bulky.send({ type: "announce", tip: tipOf(bulky.local), padding: "x".repeat(900 * 1024) });
  assert.equal(await bulky.closed, 1008);
});

test("archive verifies transfer and mined block, persists them and releases lock on restart", async t => {
  const { connect, network, instance, directory, start } = await setup(t);
  const sender = await connect(alice), recipient = await connect(bob);
  const transaction = transfer(network); sender.send({ type: "transaction", transaction });
  await recipient.wait("transaction");
  assert.equal(instance.ledger.pendingTransactions.length, 1);
  recipient.send({ type: "request_pool", to: "archive", requestId: "pool" });
  assert.equal((await recipient.wait("pool", message => message.requestId === "pool")).transactions.length, 1);
  sender.local.addTransaction(transaction); const block = await sender.local.mineBlock(alice.address);
  sender.send({ type: "block", block }); await recipient.wait("block");
  assert.equal(instance.ledger.getLastBlock().hash, block.hash);
  assert.equal(instance.ledger.getBalanceUnits(bob.address), 500);
  assert.equal(instance.ledger.pendingTransactions.length, 0);
  const stateFile = path.join(directory, network.networkId, "chain.json");
  const before = fs.readFileSync(stateFile, "utf8");
  await instance.close(); assert.equal(fs.existsSync(path.join(directory, network.networkId, ".node.lock")), false);
  const restarted = await start();
  assert.equal(restarted.ledger.getLastBlock().hash, block.hash);
  assert.equal(restarted.ledger.getBalanceUnits(bob.address), 500);
  assert.ok(fs.readFileSync(stateFile, "utf8") === before);
  await restarted.close();
});

test("archive obtains missing parent blocks with a directed correlated request", async t => {
  const { connect, instance } = await setup(t);
  const source = await connect(alice);
  for (let i = 0; i < 3; i++) await source.local.mineBlock(alice.address);
  source.send({ type: "block", block: source.local.getLastBlock() });
  const request = await source.wait("request_blocks", message => message.from === "archive");
  assert.equal(request.to, source.id); assert.equal(request.limit, 16);
  source.send({ type: "blocks", to: "archive", requestId: request.requestId,
    blocks: source.local.getBlocksAfter(request.locator, request.limit), tip: tipOf(source.local) });
  await source.wait("announce", message => message.from === "archive" && message.tip.height === 3);
  assert.equal(instance.ledger.getLastBlock().hash, source.local.getLastBlock().hash);
});

test("invalid block or unsolicited response cannot replace archive state", async t => {
  const { connect, instance } = await setup(t);
  const before = instance.ledger.exportState();
  const attacker = await connect(alice); const block = await attacker.local.mineBlock(alice.address);
  const corrupted = block.toJSON(); corrupted.hash = "0".repeat(64);
  attacker.send({ type: "block", block: corrupted }); assert.equal(await attacker.closed, 1008);
  assert.deepEqual(instance.ledger.exportState(), before);
  const unsolicited = await connect(alice);
  unsolicited.send({ type: "blocks", to: "archive", requestId: "unknown", blocks: [], tip: tipOf(unsolicited.local) });
  assert.equal(await unsolicited.closed, 1008);
  assert.deepEqual(instance.ledger.exportState(), before);
});

test("archive advances synchronization along a weaker fork past the first 16-block batch", async t => {
  const { connect, instance } = await setup(t);
  for (let i = 0; i < 20; i++) await instance.ledger.mineBlock(alice.address);
  instance.store.save(instance.ledger);
  const source = await connect(bob);
  for (let i = 0; i < 21; i++) await source.local.mineBlock(bob.address);
  source.send({ type: "announce", tip: tipOf(source.local) });
  const first = await source.wait("request_blocks");
  const prefix = source.local.getBlocksAfter(first.locator, first.limit);
  assert.equal(prefix.length, 16);
  source.send({ type: "blocks", to: "archive", requestId: first.requestId, blocks: prefix, tip: tipOf(source.local) });
  const next = await source.wait("request_blocks");
  assert.equal(next.locator[0], prefix.at(-1).hash);
  const suffix = source.local.getBlocksAfter(next.locator, next.limit);
  assert.equal(suffix.length, 5);
  source.send({ type: "blocks", to: "archive", requestId: next.requestId, blocks: suffix, tip: tipOf(source.local) });
  await source.wait("announce", message => message.from === "archive" && message.tip.hash === source.local.getLastBlock().hash);
  assert.equal(instance.ledger.getLastBlock().hash, source.local.getLastBlock().hash);
});

test("corrupt archive fails closed and backup restoration requires an explicit choice", async t => {
  const { connect, instance, directory, network, start } = await setup(t);
  const peer = await connect(alice); const block = await peer.local.mineBlock(alice.address);
  peer.send({ type: "block", block }); await peer.wait("announce", message => message.from === "archive" && message.tip.height === 1);
  await instance.close();
  const filename = path.join(directory, network.networkId, "chain.json");
  const backup = JSON.parse(fs.readFileSync(filename + ".bak", "utf8"));
  fs.writeFileSync(filename, "{corrupt");
  await assert.rejects(() => start(), /История не обнулена/);
  assert.equal(fs.readFileSync(filename, "utf8"), "{corrupt");
  assert.equal(fs.existsSync(path.join(directory, network.networkId, ".node.lock")), false);
  const restored = await start({ restoreBackup: true });
  assert.deepEqual(restored.ledger.exportState(), backup);
});

test("HTTP serves only allowed artifacts and GitHub download page", async t => {
  const assets = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-download-test-")));
  t.after(() => fs.rmSync(assets, { recursive: true, force: true }));
  fs.writeFileSync(path.join(assets, "friendcoin-linux-x64"), "synthetic public artifact");
  fs.writeFileSync(path.join(assets, "private.json"), "never served");
  const { instance } = await setup(t, { archive: false, downloadPort: 0, buildsDir: assets });
  const url = `http://127.0.0.1:${instance.downloadAddress.port}`;
  assert.ok((await (await fetch(url + "/download")).text()).includes(RELEASES_URL));
  assert.equal(await (await fetch(url + "/download/friendcoin-linux-x64")).text(), "synthetic public artifact");
  for (const endpoint of ["/server.js", "/download/private.json", "/download/../private.json", "/download/%2e%2e%2fprivate.json"]) {
    assert.equal((await fetch(url + endpoint)).status, 404);
  }
  assert.equal((await fetch(url + "/download", { method: "POST" })).status, 405);
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(assets, "private.json"), path.join(assets, "friendcoin-macos-arm64"));
    assert.equal((await fetch(url + "/download/friendcoin-macos-arm64")).status, 404);
  }
});

test("HTTP bind failure shuts down WebSocket server and releases storage lock", async t => {
  const { instance, network, directory } = await setup(t, { archive: false });
  const dataDir = path.join(directory, "failing-start");
  await assert.rejects(() => createServer({ network, dataDir, port: 0, downloadPort: instance.address.port }), error => error.code === "EADDRINUSE");
  assert.equal(fs.existsSync(path.join(dataDir, network.networkId, ".node.lock")), false);
  const healthy = await createServer({ network, dataDir, port: 0 }); await healthy.close();
});

test("server help and version do not open ports or write state", t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-server-cli-test-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(__dirname, "..", "server.js");
  for (const flag of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, [script, flag], { cwd: directory, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0); assert.ok(result.stdout.includes(flag === "--version" ? SERVER_VERSION : "--relay-only"));
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});
