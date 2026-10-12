const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { artifactName, artifactPath } = require("./build-target");
const { version } = require("../package.json");

const binary = artifactPath();
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-smoke-"));
try {
  const expected = fs.readFileSync(`${binary}.sha256`, "utf8").trim();
  const digest = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  assert.equal(expected, `${digest}  ${artifactName()}`);
  const env = { ...process.env };
  delete env.FRIENDCOIN_SERVER_URL;
  delete env.FRIENDCOIN_DATA_DIR;
  delete env.FRIENDCOIN_NETWORK;
  delete env.NODE_OPTIONS;
  for (const flag of ["--version", "--help"]) {
    const result = spawnSync(binary, [flag, "--data-dir", isolated], {
      cwd: isolated,
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${flag} failed: ${result.stderr}`);
    if (flag === "--version") assert.ok(result.stdout.includes(version), "Unexpected client version");
    else {
      for (const option of ["--server", "--data-dir", "--network", "--version", "--help"]) {
        assert.ok(result.stdout.includes(option), `Help is missing ${option}`);
      }
    }
  }
  assert.deepEqual(fs.readdirSync(isolated), [], "Help/version must not create wallet or state files");
  const dataDir = path.join(isolated, "client-data");
  const interactive = spawnSync(binary, [
    "--network", "testnet", "--data-dir", dataDir, "--server", "ws://127.0.0.1:1",
  ], {
    cwd: isolated,
    env,
    encoding: "utf8",
    input: "3\n",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  if (interactive.error) throw interactive.error;
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.ok(interactive.stdout.includes("3. Выйти") && interactive.stdout.includes("До свидания"));
  assert.deepEqual(fs.readdirSync(isolated), ["client-data"]);
  assert.deepEqual(fs.readdirSync(dataDir), ["friendcoin.config.json"], "Menu exit must not create wallets or chain state");
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, "friendcoin.config.json"), "utf8"));
  assert.equal(config.serverUrl, "ws://127.0.0.1:1/");
  console.log(`Binary smoke checks passed: ${artifactName()}, version ${version}, checksum, help and isolated menu exit`);
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}
