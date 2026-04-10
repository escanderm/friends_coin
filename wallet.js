const crypto = require("crypto");
const fs = require("fs");

class Wallet {
  constructor(name) {
    this.name = name;
    this.keys = null;
    this.address = null;
  }

  generate() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    this.keys = { publicKey, privateKey };
    this.address = publicKey;
    return this;
  }

  load(customPath) {
    try {
      const filePath = customPath || `wallet_${this.name}.json`;
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf8");
        const saved = JSON.parse(data);
        this.keys = saved.keys;
        this.address = saved.address;
        this.name = saved.name || this.name;
        console.log(`📂 Загружен кошелёк из ${filePath}`);
        return true;
      }
    } catch (e) {}
    return false;
  }

  save() {
    const data = {
      name: this.name,
      address: this.address,
      keys: this.keys,
    };
    const filePath = `wallet_${this.name}.json`;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`💾 Кошелёк сохранён: ${filePath}`);
  }

  getShortAddress() {
    const hash = crypto.createHash("sha256").update(this.address).digest("hex");
    return hash.substring(0, 16);
  }

  signTransaction(tx) {
    const sign = crypto.createSign("SHA256");
    sign.update(tx.getHash());
    tx.signature = sign.sign(this.keys.privateKey, "base64");
    tx.from = this.address;
  }
}

module.exports = { Wallet };
