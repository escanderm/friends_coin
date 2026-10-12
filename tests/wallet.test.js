const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Wallet } = require("../wallet");
const { addressFromPublicKey } = require("../protocol");
const { Transaction } = require("../blockchain");

const PASSWORD = "учебный-пароль🔑-2026";
const OTHER_PASSWORD = "другой-пароль🔑-2026";
let alice;
let bob;

test.before(() => {
  alice = new Wallet("Alice").generate();
  bob = new Wallet("Bob").generate();
});

function temporaryDirectory(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-wallet-test-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function encryptedFixture(t) {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, "wallet_Alice.fcwallet");
  alice.save(PASSWORD, filePath);
  return { directory, filePath };
}

function changedBase64(value) {
  const buffer = Buffer.from(value, "base64");
  buffer[0] ^= 1;
  return buffer.toString("base64");
}

function legacyData() {
  return { name: alice.name, address: alice.keys.publicKey, keys: { ...alice.keys } };
}

test("encrypted wallet round trip exposes only public metadata and uses private permissions", (t) => {
  const { filePath } = encryptedFixture(t);
  const contents = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(contents);
  assert.equal(data.version, 2);
  assert.equal(data.name, "Alice");
  assert.equal(data.address, addressFromPublicKey(alice.keys.publicKey));
  assert.equal(data.publicKey, alice.keys.publicKey);
  assert.ok(!contents.includes(alice.keys.privateKey));
  assert.ok(!contents.includes("PRIVATE KEY"));
  assert.ok(!contents.includes(PASSWORD));
  assert.equal(data.encryption.cipher, "aes-256-gcm");
  const metadata = Wallet.inspect(filePath);
  assert.deepEqual(Object.keys(metadata).sort(), ["address", "encrypted", "filePath", "legacy", "name", "publicKey", "version"].sort());
  assert.equal(metadata.encrypted, true);
  assert.equal(metadata.legacy, false);
  assert.equal(metadata.filePath, filePath);
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const unlocked = new Wallet("placeholder");
  assert.equal(unlocked.load(filePath, PASSWORD), true);
  assert.equal(unlocked.name, alice.name);
  assert.equal(unlocked.address, alice.address);
  assert.ok(unlocked.keys.privateKey === alice.keys.privateKey);
  assert.ok(!JSON.stringify(unlocked).includes("PRIVATE KEY"));
  assert.equal(unlocked.getShortAddress(), alice.address.slice(0, 20));
});

test("encrypted wallet remains portable when copied and renamed", (t) => {
  const { filePath } = encryptedFixture(t);
  const secondDirectory = temporaryDirectory(t);
  const destination = path.join(secondDirectory, "portable.fcwallet");
  fs.copyFileSync(filePath, destination);
  const unlocked = new Wallet("Imported");
  assert.equal(unlocked.load(destination, PASSWORD), true);
  assert.equal(unlocked.address, alice.address);
  assert.equal(unlocked.name, "Alice");
});

test("missing default returns false, explicit missing and malformed files throw", (t) => {
  const directory = temporaryDirectory(t);
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    assert.equal(new Wallet("New").load(), false);
  } finally {
    process.chdir(previousCwd);
  }
  const missing = path.join(directory, "absent.fcwallet");
  assert.throws(() => new Wallet("New").load(missing, PASSWORD), /не найден/);
  assert.throws(() => new Wallet("New").load("", PASSWORD), /непустой путь/);
  assert.throws(() => Wallet.inspect(), /Укажите путь/);
  const malformed = path.join(directory, "broken.fcwallet");
  fs.writeFileSync(malformed, "{broken");
  assert.throws(() => new Wallet("New").load(malformed, PASSWORD), /повреждён|формат/);
  assert.equal(fs.readFileSync(malformed, "utf8"), "{broken");
});

test("wrong password leaves the source and already-unlocked wallet unchanged", (t) => {
  const { filePath } = encryptedFixture(t);
  const original = fs.readFileSync(filePath, "utf8");
  const target = new Wallet("Original").generate();
  const previousAddress = target.address;
  const previousKey = target.keys.privateKey;
  assert.throws(() => target.load(filePath, OTHER_PASSWORD), /Неверный пароль/);
  assert.equal(target.name, "Original");
  assert.equal(target.address, previousAddress);
  assert.ok(target.keys.privateKey === previousKey);
  assert.ok(fs.readFileSync(filePath, "utf8") === original);
});

test("authenticated metadata, ciphertext, IV, salt and tag reject tampering", (t) => {
  const { directory, filePath } = encryptedFixture(t);
  const original = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const changes = [
    (data) => { data.name = "Mallory"; },
    (data) => { data.encryption.ciphertext = changedBase64(data.encryption.ciphertext); },
    (data) => { data.encryption.iv = changedBase64(data.encryption.iv); },
    (data) => { data.encryption.tag = changedBase64(data.encryption.tag); },
    (data) => { data.encryption.kdf.salt = changedBase64(data.encryption.kdf.salt); },
    (data) => { data.address = bob.address; },
    (data) => { data.address = bob.address; data.publicKey = bob.keys.publicKey; },
    (data) => { data.version = 3; },
  ];
  for (const [index, change] of changes.entries()) {
    const data = structuredClone(original);
    change(data);
    const destination = path.join(directory, `tampered-${index}.fcwallet`);
    fs.writeFileSync(destination, JSON.stringify(data));
    const before = fs.readFileSync(destination, "utf8");
    const target = new Wallet("Locked");
    assert.throws(() => target.load(destination, PASSWORD));
    assert.equal(target.keys, null);
    assert.equal(target.address, null);
    assert.equal(target.name, "Locked");
    assert.ok(fs.readFileSync(destination, "utf8") === before);
  }
});

test("KDF and base64/file bounds are checked before expensive key derivation", (t) => {
  const { directory, filePath } = encryptedFixture(t);
  const original = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const changes = [
    (data) => { data.encryption.kdf.N = 2 ** 30; },
    (data) => { data.encryption.kdf.r = 1024; },
    (data) => { data.encryption.kdf.p = 1000; },
    (data) => { data.encryption.kdf.keyLength = 1024; },
    (data) => { data.encryption.kdf.maxmem = 2 ** 40; },
    (data) => { data.encryption.kdf.salt = "%%%="; },
    (data) => { data.encryption.iv = Buffer.alloc(13).toString("base64"); },
    (data) => { data.encryption.tag = Buffer.alloc(15).toString("base64"); },
    (data) => { data.encryption.ciphertext = Buffer.alloc(16 * 1024 + 1).toString("base64"); },
  ];
  const originalScrypt = crypto.scryptSync;
  let calls = 0;
  crypto.scryptSync = () => { calls += 1; throw new Error("Unexpected key derivation"); };
  try {
    for (const [index, change] of changes.entries()) {
      const data = structuredClone(original);
      change(data);
      const destination = path.join(directory, `invalid-${index}.fcwallet`);
      fs.writeFileSync(destination, JSON.stringify(data));
      assert.throws(() => new Wallet("New").load(destination, PASSWORD), /повреждён|формат/);
    }
    const oversized = path.join(directory, "oversized.fcwallet");
    fs.writeFileSync(oversized, " ".repeat(64 * 1024 + 1));
    assert.throws(() => new Wallet("New").load(oversized, PASSWORD), /повреждён|формат/);
    assert.equal(calls, 0);
  } finally {
    crypto.scryptSync = originalScrypt;
  }
});

test("duplicate saves cannot overwrite, explicit replacement is complete with fresh randomness", (t) => {
  const { directory, filePath } = encryptedFixture(t);
  const original = fs.readFileSync(filePath, "utf8");
  assert.throws(() => bob.save(PASSWORD, filePath), (error) => error.code === "EEXIST");
  assert.ok(fs.readFileSync(filePath, "utf8") === original);
  assert.deepEqual(fs.readdirSync(directory), ["wallet_Alice.fcwallet"]);
  const previous = JSON.parse(original);
  assert.equal(alice.save(OTHER_PASSWORD, filePath, { overwrite: true }), filePath);
  const replacement = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.notEqual(previous.encryption.iv, replacement.encryption.iv);
  assert.notEqual(previous.encryption.kdf.salt, replacement.encryption.kdf.salt);
  const restored = new Wallet("Loaded");
  assert.equal(restored.load(filePath, OTHER_PASSWORD), true);
  assert.equal(restored.address, alice.address);
  assert.throws(() => restored.load(filePath, PASSWORD), /Неверный пароль/);
  if (process.platform !== "win32") assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("invalid save and interrupted replacement preserve the original file", (t) => {
  const { directory, filePath } = encryptedFixture(t);
  const original = fs.readFileSync(filePath, "utf8");
  assert.throws(() => alice.save("short", filePath, { overwrite: true }), /10 символов/);
  assert.ok(fs.readFileSync(filePath, "utf8") === original);
  const originalRename = fs.renameSync;
  fs.renameSync = () => { const error = new Error("Injected rename failure"); error.code = "EIO"; throw error; };
  try {
    assert.throws(() => alice.save(PASSWORD, filePath, { overwrite: true }), /Не удалось сохранить/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.ok(fs.readFileSync(filePath, "utf8") === original);
  assert.deepEqual(fs.readdirSync(directory), ["wallet_Alice.fcwallet"]);
  assert.equal(new Wallet("Recovered").load(filePath, PASSWORD), true);
});

test("explicit legacy import preserves the original key and source, then saves separately encrypted", (t) => {
  const directory = temporaryDirectory(t);
  const source = path.join(directory, "wallet_Alice.json");
  const original = JSON.stringify(legacyData(), null, 2);
  fs.writeFileSync(source, original);
  const metadata = Wallet.inspect(source);
  assert.equal(metadata.legacy, true);
  assert.equal(metadata.encrypted, false);
  assert.equal(metadata.address, alice.address);
  assert.ok(!JSON.stringify(metadata).includes("PRIVATE KEY"));
  const loaded = new Wallet("Imported");
  assert.equal(loaded.load(source), true);
  assert.ok(loaded.keys.privateKey === alice.keys.privateKey);
  assert.equal(loaded.address, alice.address);
  const encrypted = path.join(directory, "wallet_Alice.fcwallet");
  loaded.save(PASSWORD, encrypted);
  assert.ok(fs.readFileSync(source, "utf8") === original);
  assert.equal(new Wallet("Reloaded").load(encrypted, PASSWORD), true);
});

test("legacy files are never auto-loaded and their public/private/address binding is checked", (t) => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, "wallet_Alice.json"), JSON.stringify(legacyData()));
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    assert.equal(new Wallet("Alice").load(), false);
    fs.writeFileSync("wallet_Alice.fcwallet", JSON.stringify(legacyData()));
    assert.throws(() => new Wallet("Alice").load(), /явным выбором/);
  } finally {
    process.chdir(previousCwd);
  }
  for (const [index, modification] of [
    (data) => { data.address = bob.keys.publicKey; },
    (data) => { data.keys.privateKey = bob.keys.privateKey; },
  ].entries()) {
    const data = legacyData();
    modification(data);
    const destination = path.join(directory, `legacy-invalid-${index}.json`);
    fs.writeFileSync(destination, JSON.stringify(data));
    assert.throws(() => new Wallet("New").load(destination), /повреждён|формат/);
  }
  const pkcs1 = crypto.createPublicKey(alice.keys.publicKey).export({ format: "pem", type: "pkcs1" });
  const legacy = legacyData();
  legacy.address = pkcs1;
  legacy.keys.publicKey = pkcs1;
  const pkcs1Path = path.join(directory, "legacy-pkcs1.json");
  fs.writeFileSync(pkcs1Path, JSON.stringify(legacy));
  const normalized = new Wallet("Normalized");
  assert.equal(normalized.load(pkcs1Path), true);
  assert.equal(normalized.keys.publicKey, alice.keys.publicKey);
  assert.equal(normalized.address, alice.address);
});

test("save requires a password, rejects inconsistent keys, and defaults to .fcwallet", (t) => {
  const directory = temporaryDirectory(t);
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    assert.throws(() => alice.save(), /Пароль/);
    assert.throws(() => new Wallet("Empty").save(PASSWORD), /создайте|разблокируйте/);
    assert.throws(() => new Wallet("../unsafe"), /Неверное имя/);
    const inconsistent = new Wallet("Broken");
    inconsistent.address = alice.address;
    inconsistent.keys = { publicKey: alice.keys.publicKey, privateKey: bob.keys.privateKey };
    assert.throws(() => inconsistent.save(PASSWORD), /повреждён|формат/);
    assert.deepEqual(fs.readdirSync(directory), []);
    const defaultPath = alice.save(PASSWORD);
    assert.equal(defaultPath, path.join(directory, "wallet_Alice.fcwallet"));
    assert.equal(new Wallet("Alice").load(undefined, PASSWORD), true);
  } finally {
    process.chdir(previousCwd);
  }
});

test("wallet sets sender metadata before signing and signatures reject payload changes", () => {
  const tx = new Transaction({
    networkId: "wallet-test-v2",
    from: alice.address, to: bob.address, amountUnits: 100, feeUnits: 1,
    nonce: 1, timestamp: Date.now(),
  });
  assert.equal(alice.signTransaction(tx), tx);
  assert.equal(tx.from, alice.address);
  assert.equal(tx.publicKey, alice.keys.publicKey);
  assert.equal(tx.isValid(), true);
  tx.amountUnits += 1;
  assert.equal(tx.isValid(), false);
  let sawMetadata = false;
  alice.signTransaction({ sign() { sawMetadata = this.from === alice.address && this.publicKey === alice.keys.publicKey; } });
  assert.equal(sawMetadata, true);
  assert.throws(() => new Wallet("Locked").signTransaction(tx), /разблокируйте/);
});
