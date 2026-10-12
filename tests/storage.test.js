"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { ChainStore, atomicWrite } = require("../storage");
const { Blockchain } = require("../blockchain");
const { Wallet } = require("../wallet");
const testnet = require("../networks/testnet.json");

const wallet = new Wallet("StorageTest").generate();
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-storage-test-"));
  const config = { ...JSON.parse(JSON.stringify(testnet)), networkId: "storage-" + crypto.randomUUID(),
    initialTarget: "f".repeat(64), maxTarget: "f".repeat(64),
    genesis: { timestamp: Date.now() - 60000, allocations: [{ address: wallet.address, amountUnits: 50000 }] } };
  const stores = [];
  t.after(() => {
    for (const store of stores) if (store.locked) store.release();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, config, chain: new Blockchain(config),
    store() { const result = new ChainStore(directory); stores.push(result); return result; } };
}
function stalePid() {
  return Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
}

test("chain store requires an exclusive lock and releases only its own ownership", t => {
  const f = fixture(t), first = f.store(), second = f.store();
  assert.throws(() => first.save(f.chain), /заблокировано/);
  first.acquire();
  assert.throws(() => second.acquire());
  assert.equal(JSON.parse(fs.readFileSync(first.lockfile, "utf8")).owner, first.owner);
  second.release();
  assert.equal(fs.existsSync(first.lockfile), true);
  const foreign = { pid: process.pid, owner: "another-owner" };
  fs.writeFileSync(first.lockfile, JSON.stringify(foreign));
  first.release();
  assert.deepEqual(JSON.parse(fs.readFileSync(first.lockfile, "utf8")), foreign);
  fs.unlinkSync(first.lockfile);
  second.acquire(); second.release();
  assert.equal(fs.existsSync(first.lockfile), false);
});
test("stale exited PID can be reclaimed but malformed locks cannot be silently reset", t => {
  const f = fixture(t), store = f.store();
  fs.writeFileSync(store.lockfile, JSON.stringify({ pid: stalePid(), owner: "exited" }));
  store.acquire();
  assert.equal(JSON.parse(fs.readFileSync(store.lockfile, "utf8")).owner, store.owner);
  store.release();
  fs.writeFileSync(store.lockfile, "broken-lock");
  assert.throws(() => store.acquire(), /Повреждён/);
  assert.equal(fs.readFileSync(store.lockfile, "utf8"), "broken-lock");
  fs.writeFileSync(store.lockfile, JSON.stringify({ pid: 0, owner: "bad" }));
  assert.throws(() => store.acquire(), /Неверный/);
});
test("stale recovery refuses a lock replaced by another live owner", t => {
  const f = fixture(t), store = f.store(), exitedPid = stalePid();
  fs.writeFileSync(store.lockfile, JSON.stringify({ pid: exitedPid, owner: "old-stale-owner" }));
  const replacement = { pid: process.pid, owner: "another-live-owner" }, originalKill = process.kill;
  try {
    process.kill = function(pid, signal) {
      if (pid === exitedPid && signal === 0) {
        fs.writeFileSync(store.lockfile, JSON.stringify(replacement));
        const error = new Error("Process exited during owner transition"); error.code = "ESRCH"; throw error;
      }
      return originalKill(pid, signal);
    };
    assert.throws(() => store.acquire());
    assert.equal(store.locked, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.lockfile, "utf8")), replacement);
  } finally { process.kill = originalKill; }
});
test("atomic writes retain the previous verified state as backup and private modes", async t => {
  const f = fixture(t), store = f.store(); store.acquire();
  assert.equal(store.load(f.chain), false); store.save(f.chain);
  assert.equal(fs.existsSync(store.backup), false);
  const initial = fs.readFileSync(store.filename, "utf8");
  const block = await f.chain.mineBlock(wallet.address); store.save(f.chain);
  assert.equal(fs.readFileSync(store.backup, "utf8"), initial);
  const loaded = new Blockchain(f.config);
  assert.equal(store.load(loaded), true);
  assert.equal(loaded.getLastBlock().hash, block.hash);
  assert.equal(fs.readdirSync(f.directory).some(filename => filename.endsWith(".tmp")), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(store.filename).mode & 0o077, 0);
    assert.equal(fs.statSync(store.backup).mode & 0o077, 0);
    assert.equal(fs.statSync(store.lockfile).mode & 0o077, 0);
  }
});
test("interrupted atomic replacement leaves primary and verified backup readable", async t => {
  const f = fixture(t), store = f.store(); store.acquire(); store.save(f.chain);
  const original = fs.readFileSync(store.filename, "utf8");
  await f.chain.mineBlock(wallet.address);
  const rename = fs.renameSync;
  try {
    fs.renameSync = function(source, destination) {
      if (destination === store.filename) { const error = new Error("simulated rename failure"); error.code = "EIO"; throw error; }
      return rename(source, destination);
    };
    assert.throws(() => store.save(f.chain), /simulated rename failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(store.filename, "utf8"), original);
  assert.equal(fs.readFileSync(store.backup, "utf8"), original);
  assert.equal(fs.readdirSync(f.directory).some(filename => filename.endsWith(".tmp")), false);
  assert.equal(new Blockchain(f.config).loadState(JSON.parse(original)).chain.length, 1);
});
test("corrupt primary fails without resetting coins or overwriting evidence", async t => {
  const f = fixture(t), store = f.store(); store.acquire();
  await f.chain.mineBlock(wallet.address); store.save(f.chain);
  const tip = f.chain.getLastBlock().hash, balance = f.chain.getBalanceUnits(wallet.address);
  const corrupt = "{broken primary"; fs.writeFileSync(store.filename, corrupt);
  assert.throws(() => store.load(f.chain), /История не обнулена/);
  assert.equal(f.chain.getLastBlock().hash, tip);
  assert.equal(f.chain.getBalanceUnits(wallet.address), balance);
  assert.equal(fs.readFileSync(store.filename, "utf8"), corrupt);
});
test("missing primary with existing backup requires explicit restoration", t => {
  const f = fixture(t), store = f.store(); store.acquire();
  atomicWrite(store.backup, JSON.stringify(f.chain.exportState()));
  assert.throws(() => store.load(f.chain), /--restore-backup/);
  assert.equal(fs.existsSync(store.filename), false);
  assert.equal(store.load(f.chain, { restoreBackup: true }), true);
  assert.equal(fs.existsSync(store.filename), true);
});
test("reading can be unlocked but restoring primary requires lock ownership", async t => {
  const f = fixture(t), writer = f.store(); writer.acquire(); writer.save(f.chain);
  const block = await f.chain.mineBlock(wallet.address); writer.save(f.chain); writer.release();
  const before = fs.readFileSync(writer.filename, "utf8"), reader = f.store(), restored = new Blockchain(f.config);
  assert.throws(() => reader.load(restored, { restoreBackup: true }));
  assert.equal(fs.readFileSync(writer.filename, "utf8"), before);
  assert.equal(reader.load(restored), true);
  assert.equal(restored.getLastBlock().hash, block.hash);
  assert.equal(reader.locked, false);
});
test("explicit restore validates backup and preserves the corrupt original", async t => {
  const f = fixture(t), store = f.store(); store.acquire(); store.save(f.chain);
  const first = await f.chain.mineBlock(wallet.address); store.save(f.chain);
  await f.chain.mineBlock(wallet.address); store.save(f.chain);
  const corrupt = "evidence: corrupted primary"; fs.writeFileSync(store.filename, corrupt);
  const restored = new Blockchain(f.config);
  assert.equal(store.load(restored, { restoreBackup: true }), true);
  assert.equal(restored.getLastBlock().hash, first.hash);
  assert.equal(restored.getBalanceUnits(wallet.address), 50100);
  const preserved = fs.readdirSync(f.directory).filter(name => name.startsWith("chain.json.before-restore-"));
  assert.equal(preserved.length, 1);
  assert.equal(fs.readFileSync(path.join(f.directory, preserved[0]), "utf8"), corrupt);
  assert.equal(new Blockchain(f.config).loadState(fs.readFileSync(store.filename, "utf8")).getLastBlock().hash, first.hash);
});
test("invalid backup is rejected before touching primary or creating restoration evidence", async t => {
  const f = fixture(t), store = f.store(); store.acquire(); store.save(f.chain);
  await f.chain.mineBlock(wallet.address); store.save(f.chain);
  const invalid = JSON.parse(fs.readFileSync(store.backup, "utf8")); invalid.genesisHash = "0".repeat(64);
  fs.writeFileSync(store.backup, JSON.stringify(invalid));
  const corrupt = "keep this damaged primary"; fs.writeFileSync(store.filename, corrupt);
  const restored = new Blockchain(f.config), initial = restored.getLastBlock().hash;
  assert.throws(() => store.load(restored, { restoreBackup: true }), /История не обнулена/);
  assert.equal(restored.getLastBlock().hash, initial);
  assert.equal(fs.readFileSync(store.filename, "utf8"), corrupt);
  assert.equal(fs.readdirSync(f.directory).some(name => name.includes("before-restore")), false);
});
