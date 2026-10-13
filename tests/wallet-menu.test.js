const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const { Terminal, selectWallet, openWalletLocation, resolveWalletLocation, UI_CONFIG_FILE } = require("../start");
const { Wallet } = require("../wallet");

function tty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let text = "";
  const output = new Writable({ write(chunk, encoding, callback) { text += chunk; callback(); } });
  return { input, output, text: () => text };
}

test("wallet menu uses arrows and Enter, then securely returns to password input", async () => {
  const io = tty(), terminal = new Terminal(io);
  try {
    const selected = terminal.menu("Кошельки в /" + "a".repeat(150), ["Alpha", "Beta", "Выйти"]);
    io.input.emit("keypress", "", { name: "down" });
    io.input.emit("keypress", "", { name: "down" });
    io.input.emit("keypress", "", { name: "up" });
    io.input.emit("keypress", "", { name: "return" });
    assert.equal(await selected, 1);
    assert.equal(terminal.closed, false);
    assert.equal(terminal.rl.closed, undefined);
    assert.ok(!io.text().includes("Введите номер"));
    assert.ok(io.text().includes("\x1b[?25h"));
    assert.ok(io.text().includes("…"));
    assert.ok(!io.text().includes("a".repeat(100)));
    const secret = terminal.question("Пароль: ", true);
    terminal.rl.write("SyntheticPassword_123");
    terminal.rl.write(null, { name: "return" });
    assert.equal(await secret, "SyntheticPassword_123");
    assert.deepEqual(terminal.rl.history, []);
    assert.equal(terminal.rl.line, "");
    assert.ok(!io.text().includes("SyntheticPassword_123"));
  } finally { terminal.close(); io.input.destroy(); }
  assert.equal(io.input.isRaw, false);
});

test("Ctrl+C exits the arrow menu and restores cursor and raw mode", async () => {
  const io = tty(), terminal = new Terminal(io);
  try {
    const selected = terminal.menu("Кошелёк:", ["Alpha", "Выйти"]);
    io.input.emit("keypress", "", { name: "c", ctrl: true });
    assert.equal(await selected, null);
    assert.equal(terminal.closed, true);
    assert.equal(io.input.isRaw, false);
    assert.ok(io.text().includes("\x1b[?25h"));
    assert.equal(io.input.listenerCount("keypress"), 0);
  } finally { terminal.close(); io.input.destroy(); }
});

test("relative parent paths resolve from the supplied launch directory", () => {
  const base = path.join(os.tmpdir(), "wallet-path-base");
  assert.equal(resolveWalletLocation("../../", path.join(base, "one", "two")), base);
  assert.equal(resolveWalletLocation("../wallet.fcwallet", path.join(base, "one")), path.join(base, "wallet.fcwallet"));
});

function directory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-wallet-menu-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a relative folder lists wallets and remembers the selected external file", async t => {
  const root = directory(t), external = path.join(root, "external"), nested = path.join(root, "one", "two"), data = path.join(root, "data");
  for (const folder of [external, nested, data]) fs.mkdirSync(folder, { recursive: true });
  const password = "SyntheticWalletPassword_123", wallet = new Wallet("Portable").generate();
  const filename = path.join(external, "wallet_Portable.fcwallet");
  wallet.save(password, filename);
  const original = fs.readFileSync(filename);
  const previous = process.cwd();
  process.chdir(nested);
  try {
    const opened = await openWalletLocation({
      async menu(title, items) { assert.ok(title.includes(external)); assert.ok(items[0].includes("Portable")); return 0; },
      async question(prompt, secret) { assert.equal(secret, true); return password; },
    }, "../../external", data);
    assert.equal(opened.address, wallet.address);
    const config = JSON.parse(fs.readFileSync(path.join(data, UI_CONFIG_FILE), "utf8"));
    assert.deepEqual(config, { walletPath: filename });
    assert.deepEqual(fs.readFileSync(filename), original);
    const reopened = await selectWallet({ closed: false,
      async menu(title, items) { assert.ok(items[0].includes("Portable")); return 0; },
      async question(prompt, secret) { assert.equal(prompt, "Пароль кошелька: "); assert.equal(secret, true); return password; },
    }, data);
    assert.equal(reopened.address, wallet.address);
    assert.deepEqual(fs.readFileSync(filename), original);
  } finally { process.chdir(previous); }
});

test("a selected legacy wallet from a folder is imported without rewriting the original", async t => {
  const root = directory(t), external = path.join(root, "external"), data = path.join(root, "data");
  fs.mkdirSync(external); fs.mkdirSync(data);
  const wallet = new Wallet("Legacy").generate(), filename = path.join(external, "wallet_Legacy.json"), password = "LegacyPassword_123";
  const original = JSON.stringify({ name: wallet.name, address: wallet.keys.publicKey, keys: { ...wallet.keys } });
  fs.writeFileSync(filename, original, { mode: 0o600 });
  const opened = await openWalletLocation({
    async menu(title, items) { assert.ok(items[0].includes("старый")); return 0; },
    async question(prompt, secret) { assert.equal(secret, true); return password; },
  }, external, data);
  assert.equal(opened.address, wallet.address);
  assert.equal(fs.readFileSync(filename, "utf8"), original);
  const destination = path.join(external, "wallet_Legacy.fcwallet");
  assert.equal(Wallet.inspect(destination).encrypted, true);
  assert.equal(fs.existsSync(path.join(data, "wallet_Legacy.fcwallet")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, UI_CONFIG_FILE), "utf8")).walletPath, destination);
});
