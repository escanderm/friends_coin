const { Blockchain, Transaction } = require("./blockchain");
const { Wallet } = require("./wallet");
const WebSocket = require("ws");
const readline = require("readline");
const fs = require("fs");

const CLIENT_VERSION = JSON.parse(fs.readFileSync(
  require("path").join(__dirname, "package.json"), "utf8"
)).version;

class User {
  constructor(name, serverUrl = "ws://159.194.219.91:8088", walletPath = null) {
    this.name = name;
    this.serverUrl = serverUrl;
    this.walletPath = walletPath;
    this.ws = null;
    this.wallet = null;
    this.blockchain = null;
    this.ready = false;
    this.addressBook = {};
    this.rl = null;
  }

  loadLocalBlockchain() {
    try {
      const data = fs.readFileSync(`blockchain_${this.name}.json`, "utf8");
      const saved = JSON.parse(data);
      this.blockchain = new Blockchain();
      this.blockchain.chain = saved.chain;
      this.blockchain.pendingTransactions = saved.pendingTransactions || [];
      console.log(
        `📂 Загружен локальный блокчейн: ${this.blockchain.chain.length} блоков`,
      );
      if (this.blockchain.chain.length > 0) {
        console.log(
          `   Последний блок #${this.blockchain.getLastBlock().index}`,
        );
      }
      return true;
    } catch (e) {
      console.log("📂 Локального блокчейна нет");
      return false;
    }
  }

  saveLocalBlockchain() {
    if (this.blockchain) {
      const data = JSON.stringify(
        {
          chain: this.blockchain.chain,
          pendingTransactions: this.blockchain.pendingTransactions,
        },
        null,
        2,
      );
      fs.writeFileSync(`blockchain_${this.name}.json`, data);
    }
  }

  loadAddressBook() {
    try {
      const data = fs.readFileSync(`address_book_${this.name}.json`, "utf8");
      this.addressBook = JSON.parse(data);
      const count = Object.keys(this.addressBook).length;
      if (count > 0) {
        console.log(`📖 Адресная книга загружена (${count} контактов)`);
      } else {
        console.log("📖 Адресная книга пуста");
      }
    } catch (e) {
      console.log("📖 Адресная книга пуста");
    }
  }

  saveAddressBook() {
    fs.writeFileSync(
      `address_book_${this.name}.json`,
      JSON.stringify(this.addressBook, null, 2),
    );
  }

  loadWallet() {
    this.wallet = new Wallet(this.name);
    if (!this.wallet.load(this.walletPath)) {
      this.wallet.generate();
      this.wallet.save();
      console.log(`\n✅ Создан новый кошелёк для ${this.name}`);
      console.log(`🔐 Публичный ключ (адрес):`);
      console.log(`${this.wallet.address.substring(0, 80)}...`);
      console.log(`\n🔑 Приватный ключ (НЕ ПОКАЗЫВАЙТЕ НИКОМУ):`);
      console.log(`   ${this.wallet.keys.privateKey.substring(0, 80)}...`);
      console.log(`\n⚠️  Сохраните приватный ключ в надёжном месте!`);
    } else {
      this.name = this.wallet.name;
      console.log(`\n📂 Загружен кошелёк ${this.name}`);
    }
    console.log(`📍 Короткий адрес: ${this.wallet.getShortAddress()}\n`);
  }

  connect() {
    this.ws = new WebSocket(this.serverUrl);

    this.ws.on("open", () => {
      console.log(`🔌 Подключен к серверу`);
      this.ws.send(
        JSON.stringify({
          type: "register",
          name: this.name,
          address: this.wallet.address,
          version: CLIENT_VERSION,
        }),
      );
    });

    this.ws.on("message", (data) => {
      const msg = JSON.parse(data);
      this.handleMessage(msg);
    });

    this.ws.on("error", (err) => {
      console.error("❌ Ошибка подключения:", err.message);
    });

    this.ws.on("close", () => {
      console.log("🔌 Отключён от сервера");
    });
  }

  handleMessage(msg) {
    switch (msg.type) {
      case "sync":
        this.handleSync(msg);
        break;
      case "update_users":
        this.handleUpdateUsers(msg);
        break;
      case "new_transaction":
        this.handleNewTransaction(msg);
        break;
      case "new_block":
        this.handleNewBlock(msg);
        break;
      case "force_sync":
        this.handleForceSync(msg);
        break;
      case "pending_update":
        this.handlePendingUpdate(msg);
        break;
      case "update_required":
        console.log(`\n${"=".repeat(50)}`);
        console.log(`   ${msg.message}`);
        console.log(`${"=".repeat(50)}\n`);
        break;
    }
  }

  handleSync(msg) {
    console.log(`\n🔄 Синхронизация с сервером...`);
    console.log(`   Сервер прислал ${msg.chain.length} блоков`);

    const remoteChain = new Blockchain();
    remoteChain.chain = msg.chain;
    remoteChain.pendingTransactions = msg.pendingBackup || [];

    let needSubmit = false;

    if (
      !this.blockchain ||
      this.blockchain.chain.length < remoteChain.chain.length
    ) {
      this.blockchain = remoteChain;
      this.saveLocalBlockchain();
      console.log(
        `   ✅ Используем цепочку сервера (${this.blockchain.chain.length} блоков)`,
      );
    } else if (this.blockchain.chain.length > remoteChain.chain.length) {
      console.log(
        `   📤 У меня цепочка длиннее (${this.blockchain.chain.length} > ${remoteChain.chain.length})`,
      );
      console.log(
        `   📤 Отправляю свою цепочку на сервер для восстановления...`,
      );
      needSubmit = true;
    } else {
      console.log(
        `   ✅ Цепочки одинаковой длины (${this.blockchain.chain.length} блоков)`,
      );
    }

    console.log(
      `   📦 В пуле ${this.blockchain.pendingTransactions.length} транзакций`,
    );

    if (msg.users) {
      this.addressBook = msg.users;
      this.saveAddressBook();
      const friends = Object.keys(this.addressBook).filter(
        (n) => n !== this.name,
      );
      console.log(`📖 Загружена адресная книга: ${friends.length} друзей`);
      if (friends.length > 0) {
        console.log(`   ${friends.join(", ")}`);
      }
    }

    this.ready = true;
    this.showBalance();

    if (needSubmit) {
      this.ws.send(
        JSON.stringify({
          type: "submit_chain",
          chain: this.blockchain.chain,
          pendingTransactions: this.blockchain.pendingTransactions,
        }),
      );
    }
  }

  handlePendingUpdate(msg) {
    if (!this.blockchain) return;
    console.log(`\n🔄 Обновление пула транзакций...`);
    this.blockchain.pendingTransactions = msg.pendingBackup || [];
    this.saveLocalBlockchain();
    console.log(
      `   📦 В пуле ${this.blockchain.pendingTransactions.length} транзакций`,
    );
  }

  handleForceSync(msg) {
    console.log(`\n🔄 Принудительная синхронизация...`);
    this.blockchain = new Blockchain();
    this.blockchain.chain = msg.chain;
    this.blockchain.pendingTransactions = msg.pendingBackup || [];
    this.saveLocalBlockchain();
    console.log(`   ✅ Обновлено: ${this.blockchain.chain.length} блоков`);
    this.showBalance();
  }

  handleUpdateUsers(msg) {
    this.addressBook = msg.users;
    this.saveAddressBook();
    const friends = Object.keys(this.addressBook).filter(
      (n) => n !== this.name,
    );
    console.log(`\n📖 Обновлена адресная книга: ${friends.length} друзей`);
    if (friends.length > 0) {
      console.log(`   ${friends.join(", ")}`);
    }
  }

  handleNewTransaction(msg) {
    if (!this.ready) return;
    const tx = new Transaction(msg.tx.from, msg.tx.to, msg.tx.amount);
    tx.timestamp = msg.tx.timestamp;
    tx.signature = msg.tx.signature;
    if (tx.isValid()) {
      this.blockchain.pendingTransactions.push(tx);
      this.saveLocalBlockchain();
      console.log(`\n📨 Получена транзакция: ${tx.amount} монет`);
      this.showBalance();
    }
  }

  handleNewBlock(msg) {
    if (!this.ready) return;
    const lastBlock = this.blockchain.getLastBlock();
    if (msg.block.previousHash === lastBlock.hash) {
      this.blockchain.chain.push(msg.block);
      for (const tx of msg.block.transactions) {
        const index = this.blockchain.pendingTransactions.findIndex(
          (ptx) =>
            ptx.from === tx.from &&
            ptx.to === tx.to &&
            ptx.amount === tx.amount &&
            ptx.timestamp === tx.timestamp,
        );
        if (index !== -1) this.blockchain.pendingTransactions.splice(index, 1);
      }
      this.saveLocalBlockchain();
      console.log(`\n📦 Новый блок #${msg.block.index}`);
      this.showBalance();
    }
  }

  showBalance() {
    if (this.ready && this.blockchain) {
      const balance = this.blockchain.getBalance(this.wallet.address);
      console.log(`💰 Баланс: ${balance} монет`);
    }
  }

  sendCoins(toName, amount) {
    if (!this.ready) {
      console.log("⏳ Подождите, идёт синхронизация...");
      return;
    }

    if (toName === this.name) {
      console.log("❌ Нельзя отправлять монеты самому себе!");
      return;
    }

    const toAddress = this.addressBook[toName];
    if (!toAddress) {
      console.log(`❌ Друг "${toName}" не найден в адресной книге`);
      const friends = Object.keys(this.addressBook).filter(
        (n) => n !== this.name,
      );
      if (friends.length > 0) {
        console.log(`   Доступные друзья: ${friends.join(", ")}`);
      } else {
        console.log(
          `   Адресная книга пуста. Подождите, пока друзья подключатся.`,
        );
      }
      return;
    }

    const balance = this.blockchain.getBalance(this.wallet.address);
    if (balance < amount) {
      console.log(
        `❌ Недостаточно средств! Баланс: ${balance}, нужно: ${amount}`,
      );
      return;
    }

    const tx = new Transaction(this.wallet.address, toAddress, amount);
    this.wallet.signTransaction(tx);
    this.blockchain.pendingTransactions.push(tx);
    this.saveLocalBlockchain();

    this.ws.send(
      JSON.stringify({
        type: "new_transaction",
        tx: {
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          timestamp: tx.timestamp,
          signature: tx.signature,
        },
      }),
    );

    console.log(`\n💸 Отправлено ${amount} монет другу ${toName}`);
    setTimeout(() => this.showBalance(), 500);
  }

  mine() {
    if (!this.ready) {
      console.log("⏳ Подождите, идёт синхронизация...");
      return;
    }

    console.log(
      `🔍 Диагностика: pendingTransactions = ${this.blockchain?.pendingTransactions?.length || 0}`,
    );

    if (!this.blockchain || this.blockchain.pendingTransactions.length === 0) {
      console.log("⛏️ Нет транзакций для майнинга");
      return;
    }

    console.log(
      `\n⛏️ Начинаю майнинг (${this.blockchain.pendingTransactions.length} транзакций)...`,
    );
    const start = Date.now();

    const block = this.blockchain.mineBlock(this.wallet.address);
    const time = ((Date.now() - start) / 1000).toFixed(1);

    const rewardTx = block.transactions.find(tx => tx.from === "SYSTEM");
    const reward = rewardTx ? rewardTx.amount : 0;

    console.log(`   ⛏️ Блок #${block.index} добыт за ${time} секунд!`);
    console.log(`   Награда: ${reward} монет (${this.blockchain.miningRewardPercent}% от массы, макс ${this.blockchain.maxMiningReward})`);
    console.log(`   Nonce: ${block.nonce}`);
    console.log(`   Хеш: ${block.hash.substring(0, 20)}...`);

    this.ws.send(
      JSON.stringify({
        type: "new_block",
        block: {
          index: block.index,
          timestamp: block.timestamp,
          transactions: block.transactions,
          previousHash: block.previousHash,
          nonce: block.nonce,
          hash: block.hash,
        },
      }),
    );

    this.saveLocalBlockchain();
    setTimeout(() => this.showBalance(), 500);
  }

  showAddress() {
    console.log(`\n📍 Короткий адрес: ${this.wallet.getShortAddress()}`);
    console.log(`📍 Полный публичный ключ:`);
    console.log(this.wallet.address);
  }

  listFriends() {
    const friends = Object.keys(this.addressBook).filter(
      (n) => n !== this.name,
    );
    if (friends.length === 0) {
      console.log("📖 Адресная книга пуста");
      console.log(
        "   Друзья появятся автоматически, когда они подключатся к серверу",
      );
    } else {
      console.log(`\n📖 Доступные друзья (${friends.length}):`);
      for (const name of friends) {
        const shortAddr = this.addressBook[name].substring(0, 40);
        console.log(`   ${name}: ${shortAddr}...`);
      }
    }
  }

  syncPool() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "request_pending",
        }),
      );
      console.log("🔄 Запрос синхронизации пула...");
    }
  }

  help() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                     ДОСТУПНЫЕ КОМАНДЫ                        ║
╠══════════════════════════════════════════════════════════════╣
║  balance    - показать текущий баланс                        ║
║  address    - показать свой публичный адрес                  ║
║  friends    - список друзей в адресной книге                 ║
║  send <имя> <сумма> - отправить монеты другу                 ║
║  mine       - начать майнинг (подтвердить транзакции)        ║
║  syncpool   - синхронизировать пул транзакций с сервером     ║
║  help       - показать эту справку                           ║
║  exit       - выйти из программы                             ║
╚══════════════════════════════════════════════════════════════╝
`);
  }

  startCLI() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log("\n💡 Введите help для списка команд\n");
    this.prompt();
  }

  prompt() {
    this.rl.question(`${this.name}> `, (input) => {
      const parts = input.trim().split(" ");
      const cmd = parts[0].toLowerCase();

      switch (cmd) {
        case "balance":
          this.showBalance();
          break;
        case "address":
          this.showAddress();
          break;
        case "friends":
          this.listFriends();
          break;
        case "send":
          if (parts.length < 3) {
            console.log("❌ Использование: send <имя_друга> <сумма>");
            console.log("   Пример: send Bob 100");
          } else {
            const amount = parseInt(parts[2]);
            if (isNaN(amount) || amount <= 0) {
              console.log("❌ Сумма должна быть положительным числом");
            } else {
              this.sendCoins(parts[1], amount);
            }
          }
          break;
        case "mine":
          this.mine();
          break;
        case "syncpool":
          this.syncPool();
          break;
        case "help":
          this.help();
          break;
        case "exit":
          console.log("\n👋 До свидания!");
          this.saveLocalBlockchain();
          if (this.rl) this.rl.close();
          if (this.ws) this.ws.close();
          process.exit(0);
          break;
        default:
          if (input.trim()) {
            console.log(`❌ Неизвестная команда: "${cmd}"`);
            console.log("   Введите help для списка команд");
          }
      }
      this.prompt();
    });
  }

  init() {
    this.loadWallet();
    this.loadAddressBook();
    this.loadLocalBlockchain();
    this.connect();
  }
}

module.exports = { User };
