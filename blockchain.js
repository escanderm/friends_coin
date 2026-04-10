const crypto = require("crypto");

// --- Транзакция ---
class Transaction {
  constructor(from, to, amount) {
    this.from = from;
    this.to = to;
    this.amount = amount;
    this.timestamp = Date.now();
    this.signature = null;
  }

  getHash() {
    return crypto
      .createHash("sha256")
      .update(this.from + this.to + this.amount + this.timestamp)
      .digest("hex");
  }

  sign(privateKey) {
    const sign = crypto.createSign("SHA256");
    sign.update(this.getHash());
    this.signature = sign.sign(privateKey, "base64");
  }

  isValid() {
    // Награда за майнинг всегда валидна
    if (this.from === "SYSTEM") return true;

    // Обычные транзакции проверяем
    if (!this.signature) return false;

    const verify = crypto.createVerify("SHA256");
    verify.update(this.getHash());
    return verify.verify(this.from, this.signature, "base64");
  }
}

// --- Блок ---
class Block {
  constructor(index, transactions, previousHash = "") {
    this.index = index;
    this.timestamp = Date.now();
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.nonce = 0;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return crypto
      .createHash("sha256")
      .update(
        this.index +
          this.timestamp +
          JSON.stringify(this.transactions) +
          this.previousHash +
          this.nonce,
      )
      .digest("hex");
  }

  mine(difficulty = 2) {
    const target = "0".repeat(difficulty);
    while (!this.hash.startsWith(target)) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
    console.log(
      `   ⛏️  Блок ${this.index} добыт! nonce: ${this.nonce}, хеш: ${this.hash.substring(0, 10)}...`,
    );
  }
}

// --- Блокчейн ---
class Blockchain {
  constructor() {
    this.chain = [this.createGenesisBlock()];
    this.pendingTransactions = [];
    this.miningRewardPercent = 10; // % от суммы транзакций в блоке
    this.maxMiningReward = 10;     // потолок награды
    this.difficulty = 7;
  }

  createGenesisBlock() {
    const genesisTx = new Transaction("SYSTEM", "Alice", 1000);
    return new Block(0, [genesisTx], "0");
  }

  getLastBlock() {
    return this.chain[this.chain.length - 1];
  }

  addTransaction(transaction) {
    if (!transaction.isValid()) {
      throw new Error("Неверная подпись транзакции!");
    }
    if (transaction.from !== "SYSTEM" && transaction.from === transaction.to) {
      throw new Error("Нельзя отправлять монеты самому себе!");
    }
    this.pendingTransactions.push(transaction);
  }

  mineBlock(minerAddress) {
    // Считаем сумму транзакций, где майнер НЕ участник
    const txSum = this.pendingTransactions
      .filter(tx => tx.from !== minerAddress && tx.to !== minerAddress)
      .reduce((sum, tx) => sum + tx.amount, 0);

    // Награда = % от суммы транзакций, но не более потолка
    const reward = Math.min(
      parseFloat((txSum * this.miningRewardPercent / 100).toFixed(2)),
      this.maxMiningReward
    );

    const rewardTx = new Transaction("SYSTEM", minerAddress, reward);
    rewardTx.signature = "reward";

    // Все транзакции для блока (старые + награда)
    const allTxs = [...this.pendingTransactions, rewardTx];

    // Создаём блок
    const block = new Block(
      this.chain.length,
      allTxs,
      this.getLastBlock().hash,
    );

    // Майним
    block.mine(this.difficulty);

    // Добавляем в цепочку
    this.chain.push(block);

    // Очищаем пул (все транзакции уже в блоке)
    this.pendingTransactions = [];

    return block;
  }

  getBalance(address) {
    let balance = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.from === address) balance -= tx.amount;
        if (tx.to === address) balance += tx.amount;
      }
    }
    return balance;
  }

  isChainValid() {
    for (let i = 1; i < this.chain.length; i++) {
      const current = this.chain[i];
      const previous = this.chain[i - 1];

      if (current.hash !== current.calculateHash()) return false;
      if (current.previousHash !== previous.hash) return false;

      for (const tx of current.transactions) {
        if (!tx.isValid()) return false;
      }
    }
    return true;
  }
}

module.exports = { Transaction, Block, Blockchain };
