const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Writable } = require("stream");
const { isSea } = require("node:sea");
const { User } = require("./user");
const { Wallet } = require("./wallet");
const { getNetwork } = require("./network-config");
const { parseArguments, resolveDataDirectory } = require("./cli");
const { CONFIG_FILE, resolveServerConfig, validateServerUrl, saveServerUrl } = require("./server-config");
const { NAME_PATTERN } = require("./peer-protocol");
const { formatAmountUnits } = require("./protocol");
const { version } = require("./package.json");

class Terminal {
  constructor() {
    this.muted = false;
    const output = new Writable({
      write: (chunk, encoding, callback) => {
        if (this.muted) callback();
        else process.stdout.write(chunk, encoding, callback);
      },
    });
    this.rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY), historySize: 0 });
    this.rl.on("SIGINT", () => this.close());
  }

  question(prompt, secret = false) {
    if (this.rl.closed) return Promise.reject(new Error("Ввод завершён"));
    if (secret) { process.stdout.write(prompt); this.muted = true; }
    return new Promise((resolve, reject) => {
      const onClose = () => { this.muted = false; reject(new Error("Ввод завершён")); };
      this.rl.once("close", onClose);
      this.rl.question(secret ? "" : prompt, answer => {
        this.rl.removeListener("close", onClose);
        this.muted = false;
        if (secret) {
          if (this.rl.history) this.rl.history.length = 0;
          this.rl.line = "";
          this.rl.cursor = 0;
          process.stdout.write("\n");
        }
        resolve(answer);
      });
    });
  }

  close() {
    if (this.rl.history) this.rl.history.length = 0;
    this.rl.line = "";
    this.rl.cursor = 0;
    this.rl.close();
  }
}

async function choosePassword(terminal) {
  while (true) {
    const first = await terminal.question("Пароль кошелька (минимум 10 символов): ", true);
    if (Array.from(first).length < 10 || Buffer.byteLength(first, "utf8") > 1024) {
      console.log("Пароль должен содержать минимум 10 символов и не более 1024 байт");
      continue;
    }
    const second = await terminal.question("Повторите пароль: ", true);
    if (first !== second) { console.log("Пароли не совпали"); continue; }
    return first;
  }
}

async function selectWallet(terminal, dataDir, selectedPath) {
  if (selectedPath) return openWallet(terminal, path.resolve(selectedPath), dataDir);
  const files = fs.readdirSync(dataDir).filter(name => name.endsWith(".fcwallet")).sort();
  const choices = [];
  for (const filename of files) {
    try {
      const preview = Wallet.inspect(path.join(dataDir, filename));
      choices.push({ filename, preview });
    } catch (error) { console.log("Пропущен повреждённый кошелёк " + filename + ": " + error.message); }
  }
  console.log("\nВыберите кошелёк:");
  choices.forEach((choice, index) => console.log((index + 1) + ". " + choice.preview.name + " (" + choice.preview.address.slice(0, 16) + "…)"));
  const create = choices.length + 1, load = choices.length + 2, exit = choices.length + 3;
  console.log(create + ". Создать кошелёк");
  console.log(load + ". Открыть кошелёк с флешки или импортировать старый JSON");
  console.log(exit + ". Выйти");
  const answer = await terminal.question("Введите номер (1-" + exit + "): ");
  const selection = Number(answer.trim());
  if (selection === exit) { console.log("До свидания"); return null; }
  if (selection === load) {
    const filename = await terminal.question("Полный путь к кошельку: ");
    return openWallet(terminal, path.resolve(filename.trim()), dataDir);
  }
  if (selection >= 1 && selection <= choices.length) return openWallet(terminal, path.join(dataDir, choices[selection - 1].filename), dataDir);
  if (selection !== create) throw new Error("Неверный номер кошелька");
  const name = (await terminal.question("Имя (латиница, цифры, подчёркивание, до 32 символов): ")).trim();
  if (!NAME_PATTERN.test(name)) throw new Error("Неверное имя");
  const filename = path.join(dataDir, "wallet_" + name + ".fcwallet");
  if (fs.existsSync(filename)) throw new Error("Этот кошелёк уже существует");
  const password = await choosePassword(terminal);
  const wallet = new Wallet(name).generate();
  wallet.save(password, filename);
  console.log("Создан зашифрованный кошелёк: " + filename);
  console.log("Сохраните резервную копию файла и пароль отдельно. Восстановить забытый пароль программа не сможет.");
  return wallet;
}

async function openWallet(terminal, filename, dataDir) {
  const preview = Wallet.inspect(filename);
  const wallet = new Wallet(preview.name);
  if (preview.encrypted) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const password = await terminal.question("Пароль кошелька: ", true);
      try { wallet.load(filename, password); return wallet; }
      catch (error) { if (attempt === 2) throw error; console.log(error.message); }
    }
  } else {
    console.log("Выбран старый незашифрованный кошелёк. Сохраню новую зашифрованную копию; исходный файл останется.");
    wallet.load(filename);
    if (!NAME_PATTERN.test(wallet.name)) throw new Error("Имя старого кошелька не подходит для новой сети");
    const destination = path.join(dataDir, "wallet_" + wallet.name + ".fcwallet");
    const password = await choosePassword(terminal);
    wallet.save(password, destination);
    console.log("Зашифрованная копия: " + destination);
    console.log("Старый JSON содержит открытый ключ доступа. После проверки новой копии храните исходник отдельно.");
    return wallet;
  }
}

function printHelp() {
  console.log("FriendCoin " + version + "\nPortable wallet, full node and optional miner.\n");
  console.log("Options:\n--server ws://host:8088 | wss://domain\n--relay URL (repeatable additional relay)\n--data-dir PATH\n--network mainnet|testnet\n--wallet PATH\n--restore-backup\n--version\n--help");
  console.log("\nCommands:\nbalance | address | friends | info | send <address|name> <amount> [fee]\nmine | stop | history | syncpool | help | exit");
}

async function runCLI(terminal, user) {
  printHelp();
  user.showBalance();
  while (!terminal.rl.closed) {
    let input;
    try { input = await terminal.question(user.name + "> "); }
    catch { break; }
    const [command, ...args] = input.trim().split(/\s+/);
    try {
      switch ((command || "").toLowerCase()) {
        case "": break;
        case "help": printHelp(); break;
        case "balance": user.showBalance(); break;
        case "address": console.log(user.wallet.address); break;
        case "info":
          console.log("Сеть: " + user.network.networkId + "\nБлок: " + user.blockchain.getLastBlock().height + "\nХеш: " + user.blockchain.getLastBlock().hash + "\nНакопленная работа: " + user.blockchain.getChainwork() + "\nПодключено relay: " + [...user.connections.values()].filter(connection => connection.identified).length + "\nГотов: " + (user.ready ? "да" : "подключение или синхронизация") + "\nПул: " + user.blockchain.pendingTransactions.length);
          break;
        case "friends":
          for (const peer of user.peers.values()) if (peer.identity) console.log(peer.identity.name + "  " + peer.identity.address);
          break;
        case "send": {
          if (args.length < 2 || args.length > 3) throw new Error("send <адрес или имя> <сумма> [комиссия]");
          const recipient = user.resolveRecipient(args[0]);
          console.log("Получатель: " + recipient + "\nСумма: " + args[1] + " FC\nКомиссия: " + (args[2] || formatAmountUnits(user.network.minFeeUnits)) + " FC");
          const confirm = await terminal.question("Подтвердить перевод? [yes/нет]: ");
          if (confirm.trim().toLowerCase() !== "yes") { console.log("Отменено"); break; }
          const result = user.sendCoins(recipient, args[1], args[2] ?? null);
          console.log("Перевод в пуле: " + result.id + "\nПодтверждение появится после включения в блок.");
          user.showBalance();
          break;
        }
        case "mine":
          user.mine().then(block => {
            if (block) console.log("\nДобыт блок #" + block.height + ": " + block.hash);
            else console.log("\nМайнинг остановлен или вершина цепи изменилась");
          }).catch(error => console.log("\nМайнинг: " + error.message));
          break;
        case "stop": user.stopMining(); console.log("Запрошена остановка майнинга"); break;
        case "syncpool":
          for (const peer of user.peers.values()) user._request(peer.url, peer.id, "pool");
          console.log("Запрошены пулы подключённых узлов");
          break;
        case "history": {
          const tip = user.blockchain.getLastBlock().height;
          for (const block of user.blockchain.chain.slice(-20)) {
            for (const transaction of block.transactions) {
              if (transaction.from === user.wallet.address || transaction.to === user.wallet.address) {
                console.log("#" + block.height + "  " + (transaction.type || "transfer") + "  " + formatAmountUnits(transaction.amountUnits) + " FC  подтверждений: " + (tip - block.height + 1));
              }
            }
          }
          break;
        }
        case "exit": return;
        default: console.log("Неизвестная команда. Введите help");
      }
    } catch (error) { console.log(error.message); }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2), ["server", "relay", "data-dir", "network", "wallet"], ["help", "version", "restore-backup"]);
  if (options.version) { console.log(version); return; }
  if (options.help) { printHelp(); return; }
  const network = getNetwork(options.network || "mainnet");
  const dataDir = resolveDataDirectory(options["data-dir"]);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const terminal = new Terminal();
  let user;
  try {
    console.log("FriendCoin " + version + " | " + network.networkId);
    if ((options.network || "mainnet") === "mainnet" && version.includes("-")) {
      console.log("Mainnet v2: кандидат миграции. Сеть 1.x использует другой протокол. До согласованного перехода проверяйте работу в testnet.");
    }
    const config = resolveServerConfig({ argv: options.server ? ["--server", options.server] : [], cwd: dataDir });
    let serverUrl = config.serverUrl;
    if (!serverUrl && !options.server && process.cwd() !== dataDir && fs.existsSync(path.join(process.cwd(), CONFIG_FILE))) {
      serverUrl = resolveServerConfig({ argv: [], env: {}, cwd: process.cwd() }).serverUrl;
    }
    while (!serverUrl) {
      const input = await terminal.question("Адрес сервера (ws://адрес:8088 или wss://домен): ");
      try { serverUrl = validateServerUrl(input); }
      catch (error) { console.log(error.message); }
    }
    if (config.source !== "environment") saveServerUrl(serverUrl, dataDir);
    const relays = (options.relay || []).map(validateServerUrl);
    console.log("Relay: " + serverUrl + "\nДанные: " + dataDir);
    const wallet = await selectWallet(terminal, dataDir, options.wallet);
    if (!wallet) return;
    user = new User(wallet.name, serverUrl, null, { wallet, network, dataDir, relays });
    const interrupt = () => terminal.close();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      try { await user.init({ restoreBackup: Boolean(options["restore-backup"]) }); }
      catch (error) {
        if (!user.store) throw error;
        console.log(error.message + ". Переподключение продолжится автоматически.");
      }
      await runCLI(terminal, user);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  } finally {
    terminal.close();
    if (user) await user.close();
  }
}

if (require.main === module || isSea()) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { main, Terminal };
