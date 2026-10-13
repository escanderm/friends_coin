const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { WalletLock } = require("../storage");

test("wallet ownership is shared across client folders and released after exit or crash", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-lock-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "wallet.fcwallet");
  fs.writeFileSync(filename, "untouched wallet bytes");
  const original = fs.readFileSync(filename);
  const script = `
    const { WalletLock } = require(process.argv[1]);
    const lock = new WalletLock('same-wallet-address', process.argv[2], process.argv[3]);
    lock.acquire();
    process.stdout.write('locked\\n');
    process.stdin.resume();
    process.stdin.once('data', () => { lock.release(); process.exit(0); });
  `;
  async function owner() {
    const child = spawn(process.execPath, ["-e", script, require.resolve("../storage"), filename, root]);
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const [data] = await once(child.stdout, "data");
    assert.match(String(data), /locked/);
    return child;
  }
  const first = await owner();
  const duplicate = new WalletLock("same-wallet-address", path.join(root, "another-version", "copy.fcwallet"), root);
  assert.throws(() => duplicate.acquire(), /Кошелёк уже используется в другом терминале/);
  duplicate.release();
  assert.equal(fs.existsSync(duplicate.lockfile), true);
  const exited = once(first, "exit"); first.stdin.write("exit\n"); await exited;
  duplicate.acquire(); duplicate.release();
  const second = await owner();
  const crashed = once(second, "exit"); second.kill("SIGKILL"); await crashed;
  duplicate.acquire(); duplicate.release();
  assert.deepEqual(fs.readFileSync(filename), original);
  assert.equal(fs.existsSync(duplicate.lockfile), false);
});
