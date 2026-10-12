const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
const { createServer } = require("../server");
const { User } = require("../user");
const { Wallet } = require("../wallet");
const { getNetwork } = require("../network-config");
const { artifactPath } = require("./build-target");

async function waitFor(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timeout: " + label);
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-binary-e2e-"));
  const network = getNetwork("testnet");
  const password = "SyntheticPortablePassword_42";
  const walletPath = path.join(directory, "portable.fcwallet");
  const wallet = new Wallet("PortableMiner").generate();
  wallet.save(password, walletPath);
  const original = fs.readFileSync(walletPath);
  const receiverWallet = new Wallet("Receiver").generate();
  let server, receiver, child;
  try {
    server = await createServer({ network, dataDir: path.join(directory, "archive"), port: 0 });
    const url = "ws://127.0.0.1:" + server.address.port;
    receiver = new User("Receiver", url, null, { network, wallet: receiverWallet, dataDir: path.join(directory, "receiver"), reconnect: false, logger: () => {} });
    await receiver.init();
    await waitFor(() => receiver.ready, "receiver synchronization");
    const clientData = path.join(directory, "portable-data");
    const runClient = () => {
      const process = spawn(artifactPath(), ["--network", "testnet", "--server", url, "--data-dir", clientData, "--wallet", walletPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child = process;
      let output = "", errors = "";
      process.stdout.on("data", chunk => { output += chunk; });
      process.stderr.on("data", chunk => { errors += chunk; });
      const completion = new Promise((resolve, reject) => {
        process.once("error", reject);
        process.once("close", (code, signal) => resolve({ code, signal, errors }));
      });
      return {
        process, completion,
        text: () => output,
        async textAfter(text, offset = 0) { await waitFor(() => output.slice(offset).includes(text), "binary output: " + text); },
        write(line) { process.stdin.write(line + "\n"); },
      };
    };

    let client = runClient();
    await client.textAfter("Пароль кошелька:");
    client.write(password);
    await client.textAfter("PortableMiner> ");
    client.write("mine");
    await waitFor(() => receiver.blockchain.getLastBlock().height === 1, "binary mined first block");
    await waitFor(() => receiver.ready, "receiver after first block");
    let offset = client.text().length;
    client.write("send " + receiverWallet.address + " 0.25");
    await client.textAfter("Подтвердить перевод?", offset);
    client.write("yes");
    await client.textAfter("PortableMiner> ", offset);
    await waitFor(() => receiver.blockchain.pendingTransactions.length === 1, "binary signed transfer reached receiver");
    client.write("mine");
    await waitFor(() => receiver.blockchain.getLastBlock().height === 2, "binary confirmed transfer");
    assert.equal(receiver.blockchain.getBalanceUnits(receiverWallet.address), 25);
    assert.equal(receiver.blockchain.getBalanceUnits(wallet.address), 175);
    assert.equal(server.ledger.getLastBlock().hash, receiver.blockchain.getLastBlock().hash);
    assert.ok(!client.text().includes(password), "Password must not be echoed");
    client.write("exit");
    assert.equal((await client.completion).code, 0);
    assert.deepEqual(fs.readFileSync(walletPath), original, "Opening the wallet must not rewrite it");

    client = runClient();
    await client.textAfter("Пароль кошелька:");
    client.write(password);
    await client.textAfter("PortableMiner> ");
    assert.match(client.text(), /Баланс: 1\.75 FC/);
    offset = client.text().length;
    client.write("info");
    await client.textAfter("PortableMiner> ", offset);
    assert.match(client.text().slice(offset), /Блок: 2/);
    assert.ok(!client.text().includes(password));
    client.write("exit");
    assert.equal((await client.completion).code, 0);
    assert.equal(createHash("sha256").update(fs.readFileSync(walletPath)).digest("hex"), createHash("sha256").update(original).digest("hex"));
    console.log("Compiled client E2E passed: encrypted wallet, mining, signed transfer, receiver balance, restart and unchanged wallet file");
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, "close"); }
    if (receiver) await receiver.close();
    if (server) await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
