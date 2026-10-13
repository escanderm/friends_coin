const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough, Writable } = require("node:stream");
const { User } = require("../user");
const { Wallet } = require("../wallet");
const { getNetwork } = require("../network-config");
const { Terminal, runCLI } = require("../start");

const wallet = new Wallet("StatusTest").generate();
function userFixture(network = getNetwork("testnet")) {
  const user = new User(wallet.name, "ws://127.0.0.1:1", null, {
    wallet, network, logger() {},
  });
  const sent = [];
  user.connections.set(user.serverUrl, { identified: true, id: "self", socket: {
    readyState: 1, send(value) { sent.push(JSON.parse(value)); },
  } });
  user.peers.set("archive", { url: user.serverUrl, id: "archive" });
  user._updateReady();
  return { user, sent };
}

test("manual pool sync reports empty responses, suppresses unsolicited replies and reports timeouts", () => {
  const { user, sent } = userFixture(), reports = [];
  user.on("poolSync", report => reports.push(report));
  assert.equal(user.syncPool(), 1);
  assert.equal(user.syncPool(), 1);
  assert.equal(sent.length, 1, "reuse the outstanding request");
  const reply = { type: "pool", from: "archive", requestId: sent[0].requestId, transactions: [] };
  user._handle(user.serverUrl, { ...reply, from: "other-peer" });
  assert.equal(reports.length, 0);
  user._handle(user.serverUrl, reply);
  assert.deepEqual(reports, [{ status: "received", received: 0, added: 0, pending: 0, remaining: 0 }]);
  user._handle(user.serverUrl, reply);
  assert.equal(reports.length, 1);
  user.syncPool();
  user._expireRequests(Date.now() + 11000);
  assert.deepEqual(reports[1], { status: "timeout", remaining: 0 });
  user.connections.clear();
  assert.throws(() => user.syncPool(), /Нет доступных узлов/);
  assert.equal(user.requests.size, 0);
});

test("real mining emits start and progress, rejects duplicate starts, and clears status on stop", async () => {
  // A practically impossible target ensures we exercise a real hashing batch and cancellation.
  const { user } = userFixture({ ...getNetwork("testnet"), initialTarget: "0".repeat(63) + "1" });
  let started, progress;
  user.on("miningStarted", value => { started = value; });
  user.once("miningProgress", value => { progress = value; user.stopMining(); });
  const mining = user.mine();
  assert.equal(started.height, 1);
  await assert.rejects(user.mine(), /уже запущен/);
  assert.equal(await mining, null);
  assert.ok(progress.nonce > 0 && progress.hashrate > 0 && progress.elapsedMs > 0);
  assert.equal(user.mining, null);
  assert.equal(user.miningStatus, null);
});

test("async terminal status preserves a partially typed command and hides secret input", async () => {
  const input = new PassThrough(); input.isTTY = true;
  let output = "";
  const terminal = new Terminal({ input, output: new Writable({ write(chunk, enc, done) { output += chunk; done(); } }) });
  try {
    const answer = terminal.question("StatusTest> ");
    terminal.rl.write("bal");
    terminal.notify("Майнинг: 100 kH/s");
    assert.equal(terminal.rl.line, "bal");
    terminal.rl.write("ance"); terminal.rl.write(null, { name: "return" });
    assert.equal(await answer, "balance");
    assert.match(output, /Майнинг: 100 kH\/s/);
    const secret = terminal.question("Пароль: ", true);
    terminal.rl.write("SecretStatusPassword");
    terminal.notify("hidden while entering secret");
    terminal.rl.write(null, { name: "return" });
    await secret;
    assert.doesNotMatch(output, /SecretStatusPassword|hidden while/);
  } finally { terminal.close(); input.destroy(); }
});

test("CLI shows mining start/progress/result and pool results, then detaches listeners", async () => {
  const { user } = userFixture(), messages = [];
  let calls = 0;
  const terminal = { rl: {}, notify(message) { messages.push(message); }, async question() {
    if (calls++ === 0) return "mine";
    if (calls === 2) {
      user.emit("miningProgress", { height: 1, nonce: 500, hashrate: 2000, elapsedMs: 250 });
      user.emit("miningProgress", { height: 1, nonce: 600, hashrate: 2000, elapsedMs: 300 });
      user.emit("poolSync", { status: "received", received: 0, added: 0, pending: 0, remaining: 0 });
      await new Promise(resolve => setImmediate(resolve));
    }
    return "exit";
  } };
  user.blockchain.mineBlock = async () => ({ height: 1, hash: "test-block" });
  await runCLI(terminal, user);
  assert.ok(messages.some(line => line.includes("Майнинг запущен")));
  assert.equal(messages.filter(line => line.includes("kH/s")).length, 1);
  assert.ok(messages.some(line => line.includes("Добыт блок #1")));
  assert.ok(messages.some(line => line.includes("Пул пуст") && line.includes("Ожидание ответов")));
  for (const name of ["miningStarted", "miningProgress", "poolSync"]) assert.equal(user.listenerCount(name), 0);
});
