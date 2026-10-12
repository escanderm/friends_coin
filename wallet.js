const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { addressFromPublicKey, canonicalPublicKey } = require("./protocol");

const FORMAT = "friendcoin-wallet";
const VERSION = 2;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_BYTES = 16 * 1024;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_BYTES = 1024;
const SCRYPT = Object.freeze({ name: "scrypt", N: 32768, r: 8, p: 1, keyLength: 32 });
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function invalidWallet() {
  return new Error("Файл кошелька повреждён или имеет неподдерживаемый формат");
}

function validName(name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    Buffer.byteLength(name, "utf8") > 128 ||
    /[\\/<>:"|?*\x00-\x1f\x7f-\x9f]/.test(name) ||
    name === "." || name === ".."
  ) {
    throw new Error("Неверное имя кошелька: укажите имя без путей и управляющих символов");
  }
  return name;
}

function checkPassword(password) {
  if (
    typeof password !== "string" ||
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES ||
    Array.from(password).length < MIN_PASSWORD_LENGTH
  ) {
    throw new Error("Пароль кошелька должен содержать не менее 10 символов и не более 1024 байт");
  }
}

function resolveWalletPath(filePath, defaultFilePath) {
  if (filePath === undefined || filePath === null) {
    if (!defaultFilePath) throw new Error("Укажите путь к файлу кошелька");
    return path.resolve(defaultFilePath);
  }
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
    throw new Error("Укажите непустой путь к файлу кошелька");
  }
  return path.resolve(filePath);
}

function exactFields(value, fields) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field))
  ) throw invalidWallet();
}

function decodeBase64(value, exactLength, maxLength = exactLength) {
  if (
    typeof value !== "string" || !value.length ||
    value.length > Math.ceil(maxLength / 3) * 4 || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) throw invalidWallet();
  const bytes = Buffer.from(value, "base64");
  if (
    !bytes.length || bytes.length > maxLength ||
    (exactLength !== null && bytes.length !== exactLength) ||
    bytes.toString("base64") !== value
  ) throw invalidWallet();
  return bytes;
}

function normalizePublicKey(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 8192) throw invalidWallet();
  try {
    return canonicalPublicKey(crypto.createPublicKey(value));
  } catch (e) {
    throw invalidWallet();
  }
}

function validateKeyPair(publicKey, privateKey) {
  if (typeof privateKey !== "string" || Buffer.byteLength(privateKey) > MAX_CIPHERTEXT_BYTES) {
    throw invalidWallet();
  }
  try {
    const privateObject = crypto.createPrivateKey(privateKey);
    const derivedPublic = canonicalPublicKey(crypto.createPublicKey(privateObject));
    if (derivedPublic !== publicKey) throw invalidWallet();
    return { publicKey, privateKey: privateObject.export({ format: "pem", type: "pkcs8" }) };
  } catch (e) {
    throw invalidWallet();
  }
}

function readWallet(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_BYTES) throw invalidWallet();
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (!length || length > MAX_FILE_BYTES) throw invalidWallet();
    try {
      return JSON.parse(buffer.toString("utf8", 0, length));
    } catch (e) {
      throw invalidWallet();
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseEncrypted(data) {
  exactFields(data, ["format", "version", "name", "address", "publicKey", "encryption"]);
  if (data.format !== FORMAT || data.version !== VERSION) throw invalidWallet();
  const name = validName(data.name);
  const publicKey = normalizePublicKey(data.publicKey);
  if (publicKey !== data.publicKey || data.address !== addressFromPublicKey(publicKey)) throw invalidWallet();
  const encryption = data.encryption;
  exactFields(encryption, ["cipher", "kdf", "iv", "tag", "ciphertext"]);
  exactFields(encryption.kdf, ["name", "N", "r", "p", "keyLength", "salt"]);
  if (
    encryption.cipher !== "aes-256-gcm" ||
    Object.entries(SCRYPT).some(([key, value]) => encryption.kdf[key] !== value)
  ) throw invalidWallet();
  return {
    name, address: data.address, publicKey,
    salt: decodeBase64(encryption.kdf.salt, 16),
    iv: decodeBase64(encryption.iv, 12),
    tag: decodeBase64(encryption.tag, 16),
    ciphertext: decodeBase64(encryption.ciphertext, null, MAX_CIPHERTEXT_BYTES),
  };
}

function parseLegacy(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== undefined) {
    throw invalidWallet();
  }
  const name = validName(data.name);
  if (!data.keys || typeof data.keys !== "object" || Array.isArray(data.keys)) throw invalidWallet();
  const publicKey = normalizePublicKey(data.keys.publicKey);
  if (normalizePublicKey(data.address) !== publicKey) throw invalidWallet();
  const keys = validateKeyPair(publicKey, data.keys.privateKey);
  return { name, address: addressFromPublicKey(publicKey), publicKey, keys };
}

function authenticatedMetadata(data) {
  return Buffer.from(JSON.stringify({
    format: data.format, version: data.version, name: data.name,
    address: data.address, publicKey: data.publicKey,
    cipher: data.encryption.cipher,
    kdf: { ...SCRYPT, salt: data.encryption.kdf.salt },
    iv: data.encryption.iv,
  }), "utf8");
}

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM,
  });
}

function atomicSave(filePath, contents, overwrite) {
  const temporary = overwrite
    ? path.join(path.dirname(filePath), `.fcwallet-${process.pid}-${crypto.randomBytes(12).toString("hex")}.tmp`)
    : filePath;
  let fd;
  let created = false;
  let committed = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (overwrite) fs.renameSync(temporary, filePath);
    committed = true;
    try {
      const directoryFd = fs.openSync(path.dirname(filePath), "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (e) {
      // Directory fsync is unavailable on some filesystems/platforms.
    }
  } catch (e) {
    const error = new Error(e.code === "EEXIST"
      ? "Кошелёк уже существует. Для замены нужно явно разрешить overwrite"
      : `Не удалось сохранить кошелёк (${e.code || "ошибка записи"})`);
    error.code = e.code;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && (overwrite || !committed)) {
      try { fs.unlinkSync(temporary); } catch (e) {
        // The destination is already committed, or cleanup will be possible later.
      }
    }
  }
}

class Wallet {
  constructor(name) {
    this.name = validName(name);
    // Keep unlocked keys out of JSON.stringify and ordinary object inspection.
    Object.defineProperty(this, "keys", { value: null, writable: true, enumerable: false });
    this.address = null;
  }

  generate() {
    const pair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const publicKey = normalizePublicKey(pair.publicKey);
    this.keys = { publicKey, privateKey: pair.privateKey };
    this.address = addressFromPublicKey(publicKey);
    return this;
  }

  static inspect(filePath) {
    const absolutePath = resolveWalletPath(filePath);
    const data = readWallet(absolutePath);
    const encrypted = data && data.version === VERSION;
    const parsed = encrypted ? parseEncrypted(data) : parseLegacy(data);
    return {
      name: parsed.name, address: parsed.address, publicKey: parsed.publicKey,
      encrypted: !!encrypted, legacy: !encrypted, version: encrypted ? VERSION : 1,
      filePath: absolutePath,
    };
  }

  load(filePath, password) {
    const explicitPath = filePath !== undefined && filePath !== null;
    const absolutePath = resolveWalletPath(filePath, `wallet_${validName(this.name)}.fcwallet`);
    let data;
    try {
      data = readWallet(absolutePath);
    } catch (e) {
      if (e.code === "ENOENT" && !explicitPath) return false;
      if (e.code === "ENOENT") throw new Error("Указанный файл кошелька не найден");
      throw e;
    }
    let loaded;
    if (data && data.version === VERSION) {
      const parsed = parseEncrypted(data);
      checkPassword(password);
      const key = deriveKey(password, parsed.salt);
      let plaintext;
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, parsed.iv);
        decipher.setAAD(authenticatedMetadata(data));
        decipher.setAuthTag(parsed.tag);
        plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
      } catch (e) {
        throw new Error("Неверный пароль или файл кошелька повреждён/изменён");
      } finally {
        key.fill(0);
      }
      try {
        loaded = { ...parsed, keys: validateKeyPair(parsed.publicKey, plaintext.toString("utf8")) };
      } finally {
        plaintext.fill(0);
      }
    } else {
      if (!explicitPath) throw new Error("Незашифрованный кошелёк можно импортировать только явным выбором файла");
      loaded = parseLegacy(data);
    }
    // Commit only after authentication and key-pair verification succeed.
    this.name = loaded.name;
    this.address = loaded.address;
    this.keys = loaded.keys;
    return true;
  }

  save(password, filePath, { overwrite = false } = {}) {
    checkPassword(password);
    validName(this.name);
    if (typeof overwrite !== "boolean") throw new Error("overwrite должен быть true или false");
    if (!this.keys) throw new Error("Сначала создайте или разблокируйте кошелёк");
    const publicKey = normalizePublicKey(this.keys.publicKey);
    const keys = validateKeyPair(publicKey, this.keys.privateKey);
    if (this.address !== addressFromPublicKey(publicKey)) throw invalidWallet();
    const absolutePath = resolveWalletPath(filePath, `wallet_${this.name}.fcwallet`);
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const data = {
      format: FORMAT, version: VERSION, name: this.name, address: this.address, publicKey,
      encryption: {
        cipher: "aes-256-gcm", kdf: { ...SCRYPT, salt: salt.toString("base64") },
        iv: iv.toString("base64"), tag: "", ciphertext: "",
      },
    };
    const key = deriveKey(password, salt);
    const plaintext = Buffer.from(keys.privateKey, "utf8");
    try {
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(authenticatedMetadata(data));
      data.encryption.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
      data.encryption.tag = cipher.getAuthTag().toString("base64");
    } finally {
      key.fill(0);
      plaintext.fill(0);
    }
    atomicSave(absolutePath, JSON.stringify(data, null, 2) + "\n", overwrite);
    return absolutePath;
  }

  getShortAddress() {
    return this.address ? this.address.slice(0, 20) : "";
  }

  signTransaction(tx) {
    if (!this.keys) throw new Error("Сначала создайте или разблокируйте кошелёк");
    if (!tx || typeof tx.sign !== "function") throw new Error("Неверная транзакция для подписи");
    tx.from = this.address;
    tx.publicKey = this.keys.publicKey;
    tx.sign(this.keys.privateKey);
    return tx;
  }
}

module.exports = { Wallet };
