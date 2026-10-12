const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  CONFIG_FILE,
  validateServerUrl,
  resolveServerConfig,
  saveServerUrl,
} = require("../server-config");
const { User } = require("../user");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-config-test-"));
const configPath = path.join(cwd, CONFIG_FILE);
let passed = 0;

function test(name, check) {
  check();
  passed++;
  console.log(`OK: ${name}`);
}

function resolve(overrides = {}) {
  return resolveServerConfig({ argv: [], env: {}, cwd, ...overrides });
}

try {
  test("first launch has no built-in server", () => {
    assert.deepEqual(resolve(), { serverUrl: null, source: null });
  });

  test("IP addresses and future WSS domains are supported", () => {
    assert.equal(validateServerUrl(" ws://185.141.217.117:8088 "), "ws://185.141.217.117:8088/");
    assert.equal(validateServerUrl("wss://coin.example.com/socket"), "wss://coin.example.com/socket");
  });

  test("invalid server addresses fail before connecting", () => {
    for (const value of [null, "", "185.141.217.117", "ws:localhost", "ws:/localhost", "https://coin.example.com", "ws://", "ws://a:invalid", "ws://a b", "ws://a/#x", "ws://a/#", "ws://user:password@a"]) {
      assert.throws(() => validateServerUrl(value));
    }
  });

  test("saved configuration is reused", () => {
    saveServerUrl("ws://127.0.0.1:8088", cwd);
    assert.deepEqual(resolve(), { serverUrl: "ws://127.0.0.1:8088/", source: "file" });
  });

  test("environment overrides the file without changing it", () => {
    const original = fs.readFileSync(configPath, "utf8");
    assert.deepEqual(resolve({ env: { FRIENDCOIN_SERVER_URL: "wss://temporary.example.com" } }), {
      serverUrl: "wss://temporary.example.com/", source: "environment",
    });
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
  });

  test("both command-line forms override environment and file", () => {
    for (const argv of [["--server", "wss://chosen.example.com"], ["--server=wss://chosen.example.com"]]) {
      assert.deepEqual(resolve({ argv, env: { FRIENDCOIN_SERVER_URL: "ws://other.example.com" } }), {
        serverUrl: "wss://chosen.example.com/", source: "argument",
      });
    }
    assert.throws(() => resolve({ argv: ["--server"] }));
    assert.throws(() => resolve({ argv: ["--server="] }));
    assert.throws(() => resolve({ argv: ["--server", "ws://a", "--server", "ws://b"] }));
  });

  test("corrupt configuration fails clearly and can be overridden", () => {
    fs.writeFileSync(configPath, "not JSON");
    assert.throws(() => resolve(), /Повреждён friendcoin\.config\.json/);
    assert.equal(resolve({ argv: ["--server", "ws://replacement.example.com"] }).serverUrl, "ws://replacement.example.com/");
    fs.writeFileSync(configPath, JSON.stringify({ serverUrl: "https://wrong.example.com" }));
    assert.throws(() => resolve(), /ws:\/\//);
  });

  test("User uses an explicit endpoint without reading wallets or connecting", () => {
    const user = new User("Test", "wss://chosen.example.com");
    assert.equal(user.serverUrl, "wss://chosen.example.com/");
    assert.equal(user.ws, null);
    assert.equal(user.wallet, null);
  });

  test("client argument is persisted before exiting the wallet menu", () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../start.js"), "--data-dir", cwd, "--server", "ws://127.0.0.1:8088"], {
      cwd,
      env: { ...process.env, FRIENDCOIN_SERVER_URL: "wss://temporary.example.com" },
      input: "3\n",
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /До свидания/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { serverUrl: "ws://127.0.0.1:8088/" });
    assert.deepEqual(fs.readdirSync(cwd), [CONFIG_FILE]);
  });

  test("client rejects an invalid URL and exits without changing its configuration", () => {
    const original = fs.readFileSync(configPath, "utf8");
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../start.js"), "--data-dir", cwd, "--server", "https://wrong.example.com"], {
      cwd,
      env: { ...process.env, FRIENDCOIN_SERVER_URL: "" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ws:\/\//);
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
  });

  console.log(`${passed} configuration checks passed`);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
