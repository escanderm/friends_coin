const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough, Writable } = require("node:stream");
const { User } = require("../user");
const { Wallet } = require("../wallet");
const { getNetwork } = require("../network-config");
const { Terminal, runCLI, rulesText } = require("../start");

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

test("rules report follows the active network and the exact retarget boundary", async () => {
  const network = { ...getNetwork("testnet"), adjustmentInterval: 2, targetBlockTime: 30,
    initialTarget: "f".repeat(64), maxTarget: "f".repeat(64),
    genesis: { timestamp: Date.now() - 60000, allocations: [] } };
  const { user } = userFixture(network);
  assert.match(rulesText(user.blockchain), /30 с \(для всей сети\)/);
  assert.match(rulesText(user.blockchain), /к блоку #3; блоков до пересчёта: 2/);
  assert.match(rulesText(user.blockchain), /пока нет добытых блоков/);
  await user.mine();
  assert.match(rulesText(user.blockchain), /к блоку #3; блоков до пересчёта: 1/);
  await user.mine();
  const boundary = rulesText(user.blockchain);
  assert.match(boundary, /к блоку #3; блоков до пересчёта: 0 — сложность уже рассчитана/);
  assert.match(boundary, /за текущий период \(блоков: 2\):/);
  assert.match(boundary, /Сложность для блока #3:/);
  await user.mine();
  assert.match(rulesText(user.blockchain), /к блоку #5; блоков до пересчёта: 1/);
  assert.match(rulesText(user.blockchain), /за текущий период \(блоков: 1\):/);
});

test("mainnet rules display preserves the existing 10-minute, 50-block consensus", () => {
  const { user } = userFixture(getNetwork("mainnet"));
  const before = user.blockchain.genesisHash, rules = user.blockchain.rulesHash;
  const text = rulesText(user.blockchain);
  assert.match(text, /10 мин \(для всей сети\)/);
  assert.match(text, /каждые 50 блоков/);
  assert.match(text, /к блоку #51; блоков до пересчёта: 50/);
  assert.match(text, /1\.00 FC \+ комиссии/);
  assert.match(text, /1000000\.00 FC/);
  assert.match(text, /Минимальная комиссия: 0\.01 FC/);
  assert.equal(user.blockchain.genesisHash, before);
  assert.equal(user.blockchain.rulesHash, rules);
});

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
  const { user } = userFixture(), messages = [], statuses = [];
  let calls = 0;
  const terminal = { rl: {}, setStatus(message) { statuses.push(message); }, notify(message) { messages.push(message); }, async question() {
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
  assert.equal(messages.filter(line => line.includes("kH/s")).length, 0);
  assert.ok(statuses.some(line => line.includes("kH/s")));
  assert.equal(statuses.at(-1), "");
  assert.ok(messages.some(line => line.includes("Добыт блок #1")));
  assert.ok(messages.some(line => line.includes("Пул пуст") && line.includes("Ожидание ответов")));
  for (const name of ["miningStarted", "miningProgress", "poolSync"]) assert.equal(user.listenerCount(name), 0);
});

// Render the ANSI cursor operations so repeated updates must occupy one visible row.
function screen(text, columns = 80) {
  const rows = [[]]; let row = 0, col = 0;
  const ensure = () => { while (rows.length <= row) rows.push([]); };
  const tokens = text.match(/\x1b\[[0-9;?]*[A-Za-z]|[^\x1b]/gu) || [];
  for (const token of tokens) {
    if (token.startsWith('\x1b[')) {
      const op = token.at(-1), n = Number(token.slice(2, -1)) || 1;
      if (op === 'A') row = Math.max(0, row - n);
      if (op === 'B') row += n;
      if (op === 'C') col += n;
      if (op === 'D') col = Math.max(0, col - n);
      if (op === 'G') col = n - 1;
      ensure();
      if (op === 'J') { rows[row].length = col; rows.length = row + 1; }
      if (op === 'K') rows[row].length = col;
    } else if (token === '\r') col = 0;
    else if (token === '\n') { row++; col = 0; ensure(); }
    else {
      if (col >= columns) { row++; col = 0; }
      ensure(); rows[row][col++] = token;
    }
  }
  return rows.map(line => line.join('')).join('\n');
}

test('live colored status replaces its row, preserves output and edited input, and clears on stop', async t => {
  const oldTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  t.after(() => { if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm; });
  const input = new PassThrough(); input.isTTY = true;
  let output = '';
  const stream = new Writable({ write(chunk, enc, done) { output += chunk; done(); } });
  stream.isTTY = true; stream.columns = 80;
  const terminal = new Terminal({ input, output: stream });
  try {
    stream.write('PREVIOUS BALANCE\n');
    terminal.setStatus('⠋ Майнинг #2 · 0:00 · 0.0 kH/s');
    const answer = terminal.question('Test> ');
    answer.catch(() => {});
    terminal.rl.write('balnce');
    terminal.rl.write(null, { name: 'left' });
    terminal.rl.write(null, { name: 'left' });
    terminal.rl.write(null, { name: 'left' });
    for (let n = 1; n <= 20; n++) terminal.setStatus('⠹ Майнинг #2 · 0:' + String(n).padStart(2, '0') + ' · 1.36 MH/s');
    terminal.notify('POOL EMPTY');
    terminal.rl.write('a');
    await new Promise(resolve => setImmediate(resolve));
    const rendered = screen(output);
    assert.match(rendered, /PREVIOUS BALANCE\nPOOL EMPTY\n⠹ Майнинг #2 · 0:20 · 1.36 MH\/s\nTest> balance$/);
    assert.equal((rendered.match(/Майнинг/g) || []).length, 1);
    if (process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb') assert.match(output, /\x1b\[32m/);
    assert.equal(terminal.rl.line, 'balance');
    terminal.setStatus('');
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(screen(output), /Майнинг/);
    terminal.rl.write(null, { name: 'return' });
    assert.equal(await answer, 'balance');
    stream.columns = 28;
    terminal.setStatus('⠹ Майнинг #2 · 0:42 · 1.36 MH/s · 56000000 хешей · stop');
    const narrow = terminal.question('Test> ');
    const plain = terminal.promptText().replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0];
    assert.ok(Array.from(plain).length < stream.columns);
    assert.ok(plain.endsWith('…'));
    terminal.close();
    await assert.rejects(narrow, /Ввод завершён/);
  } finally { terminal.close(); input.destroy(); }
  assert.equal(stream.listenerCount('resize'), 0);
});
