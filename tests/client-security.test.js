const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { User } = require("../user");
const { Wallet } = require("../wallet");
const { getNetwork } = require("../network-config");
const { PROTOCOL_VERSION, signIdentity } = require("../peer-protocol");

const network = getNetwork("testnet");
const alice = new Wallet("Alice").generate();
const bob = new Wallet("Bob").generate();
const peerId = "d613a2a6-bf94-4799-9a71-aa4f0ed76b38";

function fixture({ defaultLogger = false } = {}) {
  const user = new User(alice.name, "ws://127.0.0.1:1", null, {
    wallet: alice,
    network,
    ...(defaultLogger ? {} : { logger() {} }),
  });
  const sent = [];
  const connection = {
    id: null, phase: "hello", identified: false, handshake: null,
    socket: { readyState: 1, send(message) { sent.push(JSON.parse(message)); }, close() {}, terminate() {} },
  };
  user.connections.set(user.serverUrl, connection);
  const welcome = {
    type: "welcome", protocolVersion: PROTOCOL_VERSION, networkId: network.networkId,
    genesisHash: user.blockchain.chain[0].hash, challenge: "a".repeat(64), peerId,
  };
  return { user, connection, sent, welcome, tip: { hash: user.blockchain.getLastBlock().hash } };
}

test("an archive flag cannot introduce an unsigned recipient alias", () => {
  const { user, tip } = fixture();
  for (const id of ["evil-peer", "archive"]) {
    user._updatePeers(user.serverUrl, [{ id, archive: true, identity: { name: "Bob", address: bob.address }, tip }]);
    assert.equal(user.peers.size, 0);
    assert.throws(() => user.resolveRecipient("Bob"), /Друг не найден/);
  }
  user._updatePeers(user.serverUrl, [{ id: "archive", archive: true, tip }]);
  assert.equal(user.peers.size, 1);
  assert.throws(() => user.resolveRecipient("Bob"), /Друг не найден/);
});

test("recipient aliases require a signed identity on this network", () => {
  const { user, tip } = fixture();
  const challenge = "b".repeat(64);
  const identity = signIdentity(bob, network.networkId, challenge);
  user._updatePeers(user.serverUrl, [{ id: "bob-peer", challenge, identity, tip }]);
  assert.equal(user.resolveRecipient("Bob"), bob.address);
  user._updatePeers(user.serverUrl, [{ id: "bob-peer", challenge, identity: { ...identity, name: "Mallory" }, tip }]);
  assert.equal(user.peers.size, 0);
  assert.throws(() => user.resolveRecipient("Mallory"), /Друг не найден/);
});

test("identified before welcome cannot make a client ready", () => {
  const { user, connection } = fixture();
  assert.throws(() => user._handle(user.serverUrl, { type: "identified", peerId: null, peers: [] }), /регистрац/);
  user._updateReady();
  assert.equal(user.ready, false);
  assert.equal(connection.identified, false);
  assert.equal(connection.phase, "hello");
});

test("a repeated welcome cannot replace the pending identity challenge", () => {
  const { user, connection, sent, welcome } = fixture();
  user._handle(user.serverUrl, welcome);
  assert.equal(connection.phase, "identify");
  assert.equal(sent.filter(message => message.type === "identify").length, 1);
  assert.throws(() => user._handle(user.serverUrl, { ...welcome, peerId: "replacement", challenge: "c".repeat(64) }), /Повторное приветствие/);
  assert.equal(connection.id, peerId);
  assert.equal(sent.filter(message => message.type === "identify").length, 1);
});

test("malformed identified payload cannot commit a ready connection", () => {
  const { user, connection, welcome } = fixture();
  user._handle(user.serverUrl, welcome);
  let connected = false;
  user.on("connected", () => { connected = true; });
  assert.throws(() => user._handle(user.serverUrl, { type: "identified", peerId, peers: {} }), /список узлов/);
  user._updateReady();
  assert.equal(connection.identified, false);
  assert.equal(connection.phase, "identify");
  assert.equal(user.ready, false);
  assert.equal(connected, false);
});

test("default network logging strips terminal control bytes and bounds message size", () => {
  const { user } = fixture({ defaultLogger: true });
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(String(line));
  try {
    user._handle(user.serverUrl, { type: "error", message: "\u001b[2J\u0007Injected" + "x".repeat(5000) });
  } finally { console.log = original; }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("Сервер: "));
  assert.ok(lines[0].length <= 2000);
  assert.doesNotMatch(lines[0], /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

test("a failed state write disables transfers and mining even while a relay remains connected", async () => {
  const { user, connection } = fixture();
  connection.identified = true;
  connection.phase = "identified";
  user._updateReady();
  assert.equal(user.ready, true);
  const controller = new AbortController();
  user.mining = controller;
  const failure = new Error("Synthetic disk full");
  user.store = { save() { throw failure; } };
  let reported;
  let stateEvents = 0;
  user.on("storageError", error => { reported = error; });
  user.on("state", () => { stateEvents++; });
  assert.throws(() => user._save(), /Synthetic disk full/);
  user._updateReady();
  assert.equal(user.ready, false);
  assert.equal(controller.signal.aborted, true);
  assert.equal(reported, failure);
  assert.equal(stateEvents, 0);
  assert.throws(() => user.sendCoins(bob.address, "1"), /Подождите подключения/);
  await assert.rejects(user.mine(), /Подождите подключения/);
});

test("secret terminal input stays out of output, history, and the next visible prompt", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { Terminal } = require(process.argv[1]);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = function(chunk, encoding, callback) {
      output += String(chunk);
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    };
    (async () => {
      const terminal = new Terminal();
      try {
        const answerPromise = terminal.question('Secret prompt: ', true);
        terminal.rl.write('SyntheticPassword123');
        terminal.rl.write(null, { name: 'return' });
        assert.equal(await answerPromise, 'SyntheticPassword123');
        assert.deepEqual(terminal.rl.history, []);
        assert.equal(terminal.rl.line, '');
        const visible = terminal.question('Visible prompt: ').catch(() => {});
        terminal.rl.write(null, { name: 'up' });
        assert.equal(terminal.rl.line, '');
        terminal.close();
        await visible;
        assert.deepEqual(terminal.rl.history, []);
        assert.equal(terminal.rl.line, '');
        assert.ok(!output.includes('SyntheticPassword123'));
      } finally {
        terminal.close();
        process.stdout.write = originalWrite;
      }
    })().catch(error => { process.stdout.write = originalWrite; console.error(error); process.exitCode = 1; });
  `, require.resolve("../start")], {
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
});
