"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { User } = require("../user");
const { Wallet } = require("../wallet");
const { validateNetwork } = require("../protocol");
const { version } = require("../package.json");

const LABEL = "io.friendcoin.container-smoke";
async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Container smoke timeout: " + label);
}
function fixtureNetwork(wallet) {
  return validateNetwork({ networkId: "container-smoke-" + crypto.randomUUID(), protocolVersion: 2, decimals: 2,
    blockRewardUnits: 100, maxSupplyUnits: 1000000, minFeeUnits: 1, maxTransactionsPerBlock: 10,
    targetBlockTime: 10, adjustmentInterval: 100, initialTarget: "f".repeat(64), maxTarget: "f".repeat(64),
    genesis: { timestamp: Date.now() - 1000, allocations: [{ address: wallet.address, amountUnits: 10000 }] } });
}

async function exerciseArchive({ makeClient, restart, sender, recipient }) {
  const clients = [];
  const connect = async (wallet, label) => {
    const user = makeClient(wallet, label); clients.push(user);
    await user.init(); await waitFor(() => user.ready, "signed handshake and synchronization");
    return user;
  };
  try {
    const alice = await connect(sender, "sender"), bob = await connect(recipient, "recipient");
    alice.sendCoins(recipient.address, "25.00");
    await waitFor(() => bob.blockchain.pendingTransactions.length === 1, "signed transfer reached peer");
    const block = await bob.mine(); assert.ok(block, "Smoke block was not mined");
    await waitFor(() => alice.ready && bob.ready && alice.blockchain.getLastBlock().hash === block.hash, "confirmed transfer");
    assert.equal(alice.blockchain.getBalanceUnits(sender.address), 7499);
    assert.equal(bob.blockchain.getBalanceUnits(recipient.address), 2601);
    const pending = alice.sendCoins(recipient.address, "5.00").transaction;
    await waitFor(() => bob.blockchain.pendingTransactions.some(tx => tx.getId() === pending.getId()), "second transfer is pending");
    await alice.close(); await bob.close();
    await restart({ blockHash: block.hash, pendingId: pending.getId() });
    // A fresh data directory prevents the client from supplying its old local state to the archive.
    const fresh = await connect(recipient, "fresh-after-restart");
    await waitFor(() => fresh.ready && fresh.blockchain.getLastBlock().hash === block.hash &&
      fresh.blockchain.pendingTransactions.some(tx => tx.getId() === pending.getId()), "archive restored chain and pending pool");
    assert.equal(fresh.blockchain.getBalanceUnits(sender.address), 7499);
    assert.equal(fresh.blockchain.getBalanceUnits(recipient.address), 2601);
    assert.equal(fresh.blockchain.getConfirmedNonce(sender.address), 1);
    assert.equal(fresh.blockchain.getAvailableBalanceUnits(sender.address), 6998);
    assert.equal(fresh.blockchain.getNextNonce(sender.address), 3);
    assert.ok([...fresh.peers.values()].some(peer => peer.id === "archive" && peer.tip?.hash === block.hash));
  } finally { await Promise.allSettled(clients.map(user => user.close())); }
}

function docker(args, { allowFailure = false, timeout = 15000 } = {}) {
  const env = { ...process.env };
  for (const variable of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[variable];
  const result = spawnSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], { env, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error("Docker " + args[0] + " failed: " + (result.error?.message || result.stderr.trim() || `exit ${result.status}`));
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: node scripts/smoke-container.js IMAGE\nRequires Linux and local /var/run/docker.sock. Tests temporary loopback containers/volume with synthetic keys. Does not pull or publish images."); return;
  }
  if (argv.length !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(argv[0])) throw new Error("Specify one already-built Docker image tag");
  if (process.platform !== "linux") throw new Error("Container smoke requires Linux and a local Docker daemon; GitHub Ubuntu runs this check");
  const image = argv[0]; docker(["image", "inspect", image]);
  const owner = crypto.randomUUID(), name = "friendcoin-smoke-" + owner, volume = name + "-data";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-container-smoke-"));
  const sender = new Wallet("ContainerAlice").generate(), recipient = new Wallet("ContainerBob").generate();
  const network = fixtureNetwork(sender), publicConfig = path.join(directory, "testnet.json");
  fs.writeFileSync(publicConfig, JSON.stringify(network), { mode: 0o644 }); // Only public genesis; private keys stay in memory.
  let volumeCreated = false, containerCreated = false;
  const confinement = ["--pull=never", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m"];
  const dataMount = ["--mount", `type=volume,source=${volume},target=/data`];
  const isolatedRun = ["run", "--rm", "--network", "none", ...confinement, ...dataMount];
  const inspectVolume = (script, args = []) => docker([...isolatedRun, "--entrypoint", "node", image, "-e", script, network.networkId, ...args]);
  const endpoints = () => {
    const ports = JSON.parse(docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]).stdout);
    const port = number => {
      const binding = ports[`${number}/tcp`]?.[0];
      assert.equal(binding?.HostIp, "127.0.0.1", "Smoke ports must bind only loopback");
      assert.match(binding.HostPort, /^[0-9]+$/); return binding.HostPort;
    };
    return { ws: `ws://127.0.0.1:${port(8088)}`, http: `http://127.0.0.1:${port(8089)}` };
  };
  try {
    docker(["volume", "create", "--label", `${LABEL}=${owner}`, volume]); volumeCreated = true;
    for (const flag of ["--version", "--help"]) {
      const output = docker([...isolatedRun, image, flag]).stdout;
      if (flag === "--version") assert.equal(output.trim(), version);
      else for (const option of ["--network", "--data-dir", "--host", "--port", "--download-port", "--relay-only", "--restore-backup"]) assert.ok(output.includes(option));
    }
    inspectVolume("const fs=require('node:fs');if(process.getuid()===0)throw Error('Container must run as nonroot');if(fs.readdirSync('/data').length)throw Error('Help/version created state');");
    docker(["run", "--detach", "--name", name, "--label", `${LABEL}=${owner}`, ...confinement, ...dataMount,
      "--mount", `type=bind,source=${publicConfig},target=/app/networks/testnet.json,readonly`,
      "--publish", "127.0.0.1::8088", "--publish", "127.0.0.1::8089", image,
      "--network", "testnet", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "8088", "--download-port", "8089"]);
    containerCreated = true;
    const waitForHttp = () => waitFor(async () => {
      try {
        const response = await fetch(endpoints().http + "/download", { signal: AbortSignal.timeout(1000) });
        return response.status === 200 && (await response.text()).includes("https://github.com/escanderm/friends_coin/releases");
      } catch { return false; }
    }, "loopback HTTP readiness");
    await waitForHttp();
    await exerciseArchive({ sender, recipient,
      makeClient: (wallet, label) => new User(wallet.name, endpoints().ws, null, {
        network, wallet, dataDir: path.join(directory, label), reconnect: false, logger: () => {},
      }),
      restart: async ({ blockHash, pendingId }) => {
        docker(["stop", "--time", "10", name], { timeout: 20000 });
        assert.equal(docker(["inspect", "--format", "{{.State.ExitCode}}", name]).stdout.trim(), "0");
        inspectVolume([
          "const fs=require('node:fs'),path=require('node:path'),{Transaction}=require('./blockchain');",
          "const dir=path.join('/data',process.argv[1]);",
          "if(fs.existsSync(path.join(dir,'.node.lock')))throw Error('Lock survived graceful stop');",
          "for(const name of ['chain.json','chain.json.bak'])if((fs.statSync(path.join(dir,name)).mode&0o777)!==0o600)throw Error('State permissions must be 0600');",
          "const state=JSON.parse(fs.readFileSync(path.join(dir,'chain.json'),'utf8'));",
          "if(state.blocks.length!==1||state.blocks[0].hash!==process.argv[2]||state.pendingTransactions.length!==1||new Transaction(state.pendingTransactions[0]).getId()!==process.argv[3])throw Error('Archive state was not persisted');",
        ].join("\n"), [blockHash, pendingId]);
        docker(["start", name]); await waitForHttp();
      },
    });
    console.log("Container smoke passed: nonroot/read-only runtime, version/help, loopback HTTP/WebSocket, signed transfer/block, restored chain and pending pool after restart");
  } catch (error) {
    if (containerCreated) {
      const logs = docker(["logs", "--tail", "40", name], { allowFailure: true });
      if (logs.stdout || logs.stderr) process.stderr.write("Synthetic smoke container logs:\n" + logs.stdout + logs.stderr);
    }
    throw error;
  } finally {
    if (containerCreated) {
      const label = docker(["inspect", "--format", `{{ index .Config.Labels "${LABEL}" }}`, name], { allowFailure: true });
      if (label.status === 0 && label.stdout.trim() === owner) docker(["rm", "--force", name], { allowFailure: true });
    }
    if (volumeCreated) {
      const label = docker(["volume", "inspect", "--format", `{{ index .Labels "${LABEL}" }}`, volume], { allowFailure: true });
      if (label.status === 0 && label.stdout.trim() === owner) docker(["volume", "rm", volume], { allowFailure: true });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, exerciseArchive, fixtureNetwork };
