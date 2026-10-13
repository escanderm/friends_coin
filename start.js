const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { Writable } = require("stream");
const { isSea } = require("node:sea");
const { User } = require("./user");
const { Wallet } = require("./wallet");
const { getNetwork } = require("./network-config");
const { parseArguments, resolveDataDirectory } = require("./cli");
const { CONFIG_FILE, resolveServerConfig, validateServerUrl, saveServerUrl } = require("./server-config");
const { NAME_PATTERN } = require("./peer-protocol");
const { formatAmountUnits, blockWork, RETARGET_FACTOR } = require("./protocol");
const { version } = require("./package.json");
const { atomicWrite, WalletLock } = require("./storage");
const UI_CONFIG_FILE = "friendcoin.ui.json";

class Terminal {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.closed = false;
    this.muted = false;
    this.status = "";
    this.readlineOutput = new Writable({
      write: (chunk, encoding, callback) => {
        // Keep readline output ordered with direct status writes in the same tick.
        if (!this.muted) this.output.write(chunk, encoding);
        callback();
      },
    });
    Object.defineProperty(this.readlineOutput, "columns", { get: () => this.output.columns || 80 });
    this.onResize = () => { this.refreshPrompt(); };
    this.output.on("resize", this.onResize);
    this.openReadline();
  }

  get interactive() { return Boolean(this.input.isTTY && this.output.isTTY && process.env.TERM !== "dumb"); }

  promptText() {
    if (!this.interactive || !this.status) return this.questionPrompt;
    const width = Math.max(1, (this.output.columns || 80) - 1);
    const characters = Array.from(this.status);
    const line = characters.length > width ? characters.slice(0, Math.max(0, width - 1)).join("") + "…" : this.status;
    const color = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
    return (color ? "\x1b[32m" + line + "\x1b[0m" : line) + "\n" + this.questionPrompt;
  }

  refreshPrompt(update = () => {}) {
    const redraw = this.waitingForInput && this.interactive && !this.muted && !this.closed;
    update();
    // Readline owns the previous prompt height, including wrapped input.
    if (redraw) { this.rl.setPrompt(this.promptText()); this.rl.prompt(true); }
  }

  setStatus(message) {
    this.refreshPrompt(() => { this.status = message; });
  }

  openReadline() {
    this.rl = readline.createInterface({ input: this.input, output: this.readlineOutput, terminal: Boolean(this.input.isTTY), historySize: 0 });
    this.rl.on("SIGINT", () => this.close());
    this.rl.on("close", () => { if (!this.switchingInput) this.closed = true; });
  }

  question(prompt, secret = false) {
    if (this.rl.closed) return Promise.reject(new Error("Ввод завершён"));
    this.questionPrompt = prompt;
    this.waitingForInput = true;
    if (secret) { this.output.write(prompt); this.muted = true; }
    return new Promise((resolve, reject) => {
      const onClose = () => { this.waitingForInput = false; this.muted = false; reject(new Error("Ввод завершён")); };
      this.rl.once("close", onClose);
      this.rl.question(secret ? "" : this.promptText(), answer => {
        this.rl.removeListener("close", onClose);
        this.waitingForInput = false;
        this.muted = false;
        if (secret) {
          if (this.rl.history) this.rl.history.length = 0;
          this.rl.line = "";
          this.rl.cursor = 0;
          this.output.write("\n");
        }
        resolve(answer);
      });
    });
  }

  notify(message) {
    if (this.closed || this.muted) return;
    const redraw = this.waitingForInput && this.input.isTTY;
    if (redraw) {
      const position = this.rl.getCursorPos();
      readline.moveCursor(this.output, -position.cols, -position.rows);
      readline.clearScreenDown(this.output);
      // The cursor is now at a fresh line; don't move up a second time on redraw.
      this.rl.prevRows = 0;
    }
    this.output.write((this.waitingForInput && !redraw ? "\n" : "") + message + "\n");
    if (redraw) this.rl.prompt(true);
  }

  async menu(title, items) {
    if (this.closed || !items.length) throw new Error("Ввод завершён");
    if (!this.input.isTTY || typeof this.input.setRawMode !== "function") {
      this.output.write(title + "\n" + items.map((item, index) => (index + 1) + ". " + item).join("\n") + "\n");
      const answer = await this.question("Введите номер (1-" + items.length + "): ");
      const index = Number(answer.trim()) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new Error("Неверный номер кошелька");
      return index;
    }
    // Readline owns raw input while asking questions; release it for the menu.
    this.switchingInput = true;
    this.rl.close();
    this.switchingInput = false;
    const previousRaw = Boolean(this.input.isRaw);
    const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    const display = value => {
      const characters = Array.from(clean(value)), width = Math.max(8, (this.output.columns || 80) - 6);
      return characters.length > width ? characters.slice(0, width - 1).join("") + "…" : characters.join("");
    };
    let selected = 0, rendered = false;
    const render = () => {
      if (rendered) readline.moveCursor(this.output, 0, -(items.length + 1));
      const lines = [display(title), ...items.map((item, index) => index === selected ? "\x1b[36m\x1b[1m ▸ " + display(item) + "\x1b[0m" : "   " + display(item))];
      for (const line of lines) { readline.clearLine(this.output, 0); readline.cursorTo(this.output, 0); this.output.write(line + "\n"); }
      rendered = true;
    };
    return new Promise((resolve, reject) => {
      const finish = (index, error) => {
        this.input.removeListener("keypress", onKey);
        this.input.removeListener("end", onEnd);
        this.menuCancel = null;
        this.input.setRawMode(previousRaw);
        this.output.write("\x1b[0m\x1b[?25h");
        if (!this.closed) this.openReadline();
        else this.input.pause();
        if (error) reject(error); else resolve(index);
      };
      const onEnd = () => { this.closed = true; finish(null, new Error("Ввод завершён")); };
      const onKey = (_, key = {}) => {
        if (key.ctrl && key.name === "c") { this.closed = true; finish(null); }
        else if (key.name === "up") { selected = Math.max(0, selected - 1); render(); }
        else if (key.name === "down") { selected = Math.min(items.length - 1, selected + 1); render(); }
        else if (key.name === "return" || key.name === "enter") finish(selected);
        else if (key.name === "escape") finish(null);
      };
      this.menuCancel = () => finish(null);
      readline.emitKeypressEvents(this.input);
      this.input.on("keypress", onKey);
      this.input.once("end", onEnd);
      this.input.setRawMode(true);
      this.input.resume();
      this.output.write("\x1b[?25l");
      render();
    });
  }

  close() {
    if (!this.closed && this.status) this.setStatus("");
    this.closed = true;
    this.output.removeListener("resize", this.onResize);
    if (this.menuCancel) this.menuCancel();
    if (this.rl.history) this.rl.history.length = 0;
    this.rl.line = "";
    this.rl.cursor = 0;
    this.rl.close();
  }
}

function resolveWalletLocation(input, base = isSea() || process.pkg ? path.dirname(process.execPath) : process.cwd()) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Укажите путь к папке или файлу кошелька");
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(base, value);
}

function lastWalletPath(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, UI_CONFIG_FILE), "utf8")).walletPath;
    return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") ? value : null;
  } catch { return null; }
}

function rememberWallet(dataDir, filename) {
  atomicWrite(path.join(dataDir, UI_CONFIG_FILE), JSON.stringify({ walletPath: path.resolve(filename) }, null, 2) + "\n");
}

function walletFiles(directory) {
  return fs.readdirSync(directory).filter(name => name.endsWith(".fcwallet") || /^wallet_.+\.json$/.test(name)).sort().map(name => path.join(directory, name));
}

function walletLabel(filename) {
  if (filename.endsWith(".json")) return path.basename(filename).replace(/^wallet_/, "").replace(/\.json$/, "") + " (старый кошелёк — импорт)";
  const preview = Wallet.inspect(filename);
  return preview.name + " (" + preview.address.slice(0, 16) + "…)";
}

async function openWalletLocation(terminal, input, dataDir) {
  const location = resolveWalletLocation(input);
  const stat = fs.statSync(location);
  if (stat.isFile()) return openWallet(terminal, location, dataDir);
  if (!stat.isDirectory()) throw new Error("Укажите папку или файл кошелька");
  const files = walletFiles(location);
  if (!files.length) throw new Error("Кошельки не найдены в этой папке");
  const selection = await terminal.menu("📂 Кошельки в " + location + ":", [...files.map(walletLabel), "Назад"]);
  if (selection === null || selection === files.length) return null;
  return openWallet(terminal, files[selection], dataDir);
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
  if (selectedPath) return openWalletLocation(terminal, selectedPath, dataDir);
  while (!terminal.closed) {
    const launchDir = resolveWalletLocation(".");
    const remembered = lastWalletPath(dataDir);
    const candidates = [...(remembered && fs.existsSync(remembered) ? [remembered] : []), ...walletFiles(dataDir), ...(launchDir !== dataDir ? walletFiles(launchDir) : [])];
    const choices = [];
    for (const filename of new Set(candidates)) {
      try { choices.push({ filename, label: walletLabel(filename) }); }
      catch { console.log("Пропущен повреждённый кошелёк: " + path.basename(filename).replace(/[\u0000-\u001f\u007f-\u009f]/g, "")); }
    }
    const selection = await terminal.menu("📂 Выберите кошелёк:", [...choices.map(choice => choice.label), "Создать нового пользователя", "Загрузить кошелёк с флешки/диска", "Выйти"]);
    if (selection === null || selection === choices.length + 2) { console.log("До свидания!"); return null; }
    if (selection < choices.length) return openWallet(terminal, choices[selection].filename, dataDir);
    if (selection === choices.length + 1) {
      const location = await terminal.question("Путь к папке или файлу кошелька: ");
      try {
        const wallet = await openWalletLocation(terminal, location, dataDir);
        if (wallet) return wallet;
      } catch (error) { console.log(error.message); }
      continue;
    }
    let name, filename;
    while (!terminal.closed) {
      name = (await terminal.question("Введите ваше имя (латиница, цифры, подчёркивание, до 32 символов): ")).trim();
      filename = path.join(dataDir, "wallet_" + name + ".fcwallet");
      if (!NAME_PATTERN.test(name)) { console.log("Имя может содержать только латиницу, цифры и подчёркивание, до 32 символов"); continue; }
      if (fs.existsSync(filename)) { console.log("Этот кошелёк уже существует"); continue; }
      break;
    }
    const password = await choosePassword(terminal);
    const wallet = new Wallet(name).generate();
    terminal.acquireWallet?.(wallet.address, filename);
    wallet.save(password, filename);
    rememberWallet(dataDir, filename);
    console.log("Создан зашифрованный кошелёк: " + filename);
    console.log("Сохраните резервную копию файла и пароль отдельно. Восстановить забытый пароль программа не сможет.");
    return wallet;
  }
  return null;
}

async function openWallet(terminal, filename, dataDir) {
  const preview = Wallet.inspect(filename);
  terminal.acquireWallet?.(preview.address, filename);
  try {
    const wallet = new Wallet(preview.name);
    if (preview.encrypted) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const password = await terminal.question("Пароль кошелька: ", true);
        try { wallet.load(filename, password); rememberWallet(dataDir, filename); return wallet; }
        catch (error) { if (attempt === 2) throw error; console.log(error.message); }
      }
    } else {
      console.log("Выбран старый незашифрованный кошелёк. Сохраню новую зашифрованную копию; исходный файл останется.");
      wallet.load(filename);
      if (!NAME_PATTERN.test(wallet.name)) throw new Error("Имя старого кошелька не подходит для новой сети");
      const destination = path.join(path.dirname(filename), "wallet_" + wallet.name + ".fcwallet");
      if (fs.existsSync(destination)) throw new Error("Зашифрованная копия уже существует. Откройте файл: " + destination);
      console.log("Зашифрованная копия будет сохранена рядом с исходным кошельком: " + destination);
      const password = await choosePassword(terminal);
      wallet.save(password, destination);
      rememberWallet(dataDir, destination);
      console.log("Зашифрованная копия: " + destination);
      console.log("Старый JSON содержит открытый ключ доступа. После проверки новой копии храните исходник отдельно.");
      return wallet;
    }
  } catch (error) {
    terminal.releaseWallet?.();
    throw error;
  }
}

function miningText(status) {
  if (!status) return "Майнинг: не запущен";
  const seconds = Math.floor(status.elapsedMs / 1000);
  const rate = status.hashrate >= 1000000 ? (status.hashrate / 1000000).toFixed(2) + " MH/s"
    : status.hashrate >= 1000 ? (status.hashrate / 1000).toFixed(1) + " kH/s" : Math.round(status.hashrate) + " H/s";
  return "Майнинг блока #" + status.height + ": " + seconds + " с | " + rate + " | проверено хешей: " + status.nonce;
}

function miningLine(status, frame) {
  const seconds = Math.floor(status.elapsedMs / 1000);
  const time = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  const rate = status.hashrate >= 1000000 ? (status.hashrate / 1000000).toFixed(2) + " MH/s"
    : (status.hashrate / 1000).toFixed(1) + " kH/s";
  const hashes = status.nonce >= 1000000 ? (status.nonce / 1000000).toFixed(1) + " млн" : String(status.nonce);
  return "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10] + " Майнинг #" + status.height + " · " + time + " · " + rate + " · " + hashes + " хешей · stop";
}

function durationText(seconds) {
  const rounded = Math.round(seconds);
  if (rounded < 60) return rounded + " с";
  const minutes = Math.floor(rounded / 60), remainder = rounded % 60;
  return minutes + " мин" + (remainder ? " " + remainder + " с" : "");
}

function rulesText(blockchain) {
  const network = blockchain.network, tip = blockchain.getLastBlock();
  const interval = network.adjustmentInterval;
  const periodStart = Math.floor(Math.max(0, tip.height - 1) / interval) * interval;
  const measuredBlocks = tip.height - periodStart;
  const adjustmentHeight = periodStart + interval + 1;
  const remaining = adjustmentHeight - 1 - tip.height;
  const average = measuredBlocks ? (tip.timestamp - blockchain.chain[periodStart].timestamp) / measuredBlocks / 1000 : null;
  const issued = blockchain.getIssuedUnits();
  const reward = Math.min(network.blockRewardUnits, network.maxSupplyUnits - issued);
  return [
    "Правила сети: " + network.networkId,
    "Целевое среднее время блока: " + durationText(network.targetBlockTime) + " (для всей сети)",
    "Пересчёт сложности: каждые " + interval + " блоков; изменение не более чем в " + RETARGET_FACTOR + " раза за пересчёт",
    "Следующий пересчёт применяется к блоку #" + adjustmentHeight + "; блоков до пересчёта: " + remaining + (remaining === 0 ? " — сложность уже рассчитана" : ""),
    "Сложность для блока #" + (tip.height + 1) + ": в среднем " + blockWork(blockchain.getNextTarget()).toLocaleString("ru-RU") + " хешей",
    "Среднее время за текущий период (блоков: " + measuredBlocks + "): " + (average === null ? "пока нет добытых блоков" : durationText(average)),
    "Быстрые блоки повышают сложность, медленные снижают её. Время отдельного блока случайно.",
    "Награда за следующий блок: " + formatAmountUnits(reward) + " FC + комиссии переводов",
    "Выпущено: " + formatAmountUnits(issued) + " / " + formatAmountUnits(network.maxSupplyUnits) + " FC",
    "Минимальная комиссия: " + formatAmountUnits(network.minFeeUnits) + " FC; переводов в блоке: до " + network.maxTransactionsPerBlock,
  ].join("\n");
}

function printHelp() {
  console.log("FriendCoin " + version + "\nPortable wallet, full node and optional miner.\n");
  console.log("Options:\n--server ws://host:8088 | wss://domain\n--relay URL (repeatable additional relay)\n--data-dir PATH\n--network mainnet|testnet\n--wallet PATH\n--restore-backup\n--version\n--help");
  console.log("\nCommands:\nbalance | address | friends | info | rules | send <address|name> <amount> [fee]\nmine | stop | history | syncpool | help | exit");
}

async function runCLI(terminal, user) {
  let frame = 0;
  const started = status => {
    frame = 0;
    if (!terminal.interactive) terminal.notify("Майнинг запущен: поиск блока #" + status.height + ". Остановить: stop. Текущий статус: info");
    terminal.setStatus(miningLine(status, frame++));
  };
  const progress = status => {
    terminal.setStatus(miningLine(status, frame++));
  };
  const pool = result => {
    if (result.status !== "received") {
      terminal.notify("Синхронизация пула: " + (result.status === "timeout" ? "узел не ответил за 10 секунд" : "соединение с узлом потеряно") + ". Ожидается ответов: " + result.remaining);
      return;
    }
    terminal.notify("Пул: получено переводов — " + result.received + ", добавлено — " + result.added + ". " +
      (result.pending ? "Ожидают блока: " + result.pending + "." : "Пул пуст — неподтверждённых переводов нет.") +
      (result.remaining ? " Ожидается ответов: " + result.remaining : " Ожидание ответов завершено."));
  };
  user.on("miningStarted", started);
  user.on("miningProgress", progress);
  user.on("poolSync", pool);
  try {
    printHelp();
    user.showBalance();
    console.log("Цель сети: " + durationText(user.network.targetBlockTime) + " на блок в среднем. Пересчёт сложности: каждые " + user.network.adjustmentInterval + " блоков. Подробности: rules");
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
            console.log(miningText(user.miningStatus));
            console.log(rulesText(user.blockchain));
            break;
          case "rules": console.log(rulesText(user.blockchain)); break;
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
              terminal.setStatus("");
              if (block) terminal.notify("Добыт блок #" + block.height + ": " + block.hash + "\nМайнинг завершён. Следующий блок: mine");
              else terminal.notify("Майнинг остановлен или в сети появился новый блок. Запустить снова: mine");
            }).catch(error => {
              if (!user.mining) terminal.setStatus("");
              terminal.notify("Майнинг: " + error.message);
            });
            break;
          case "stop":
            console.log(user.mining ? "Останавливаю майнинг…" : "Майнинг не запущен");
            user.stopMining();
            break;
          case "syncpool":
            console.log("Синхронизация пула: запрошено узлов — " + user.syncPool() + ". Ожидаю ответы (до 10 секунд)…");
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
  } finally {
    terminal.setStatus("");
    user.removeListener("miningStarted", started);
    user.removeListener("miningProgress", progress);
    user.removeListener("poolSync", pool);
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
  let walletLock;
  terminal.acquireWallet = (address, filename) => {
    const lock = new WalletLock(address, filename);
    lock.acquire();
    walletLock = lock;
  };
  terminal.releaseWallet = () => { walletLock?.release(); walletLock = null; };
  let user;
  try {
    console.log("FriendCoin " + version + " | " + network.networkId);
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
    user = new User(wallet.name, serverUrl, null, { wallet, network, dataDir, relays, logger: message => terminal.notify(String(message).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 2000)) });
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
    try { if (user) await user.close(); }
    finally { terminal.releaseWallet(); }
  }
}

if (require.main === module || isSea()) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { main, Terminal, selectWallet, openWalletLocation, resolveWalletLocation, UI_CONFIG_FILE, runCLI, rulesText };
