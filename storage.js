const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

function atomicWrite(filename, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + "." + crypto.randomUUID() + ".tmp";
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

class ChainStore {
  constructor(directory) {
    this.directory = directory;
    this.filename = path.join(directory, "chain.json");
    this.backup = this.filename + ".bak";
    this.lockfile = path.join(directory, ".node.lock");
    this.owner = crypto.randomUUID();
    this.lastValidContents = null;
    this.locked = false;
  }

  acquire() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const gate = this.lockfile + ".acquire";
    try { fs.mkdirSync(gate, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("Другой процесс захватывает папку данных. Если он аварийно завершился, проверьте " + gate);
      throw error;
    }
    try {
      fs.writeFileSync(path.join(gate, "owner.json"), JSON.stringify({ pid: process.pid, owner: this.owner }), { flag: "wx", mode: 0o600 });
      if (fs.existsSync(this.lockfile)) {
        let lock, original;
        try { original = fs.readFileSync(this.lockfile, "utf8"); lock = JSON.parse(original); }
        catch { throw new Error("Повреждён файл блокировки: " + this.lockfile); }
        if (!Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error("Неверный файл блокировки");
        try {
          process.kill(lock.pid, 0);
          throw new Error("Эта папка данных уже используется процессом " + lock.pid);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
          if (fs.readFileSync(this.lockfile, "utf8") !== original) throw new Error("Блокировка изменилась при проверке владельца");
          fs.unlinkSync(this.lockfile);
        }
      }
      const descriptor = fs.openSync(this.lockfile, "wx", 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, owner: this.owner })); }
      finally { fs.closeSync(descriptor); }
      this.locked = true;
    } finally {
      const ownerPath = path.join(gate, "owner.json");
      if (fs.existsSync(ownerPath)) fs.unlinkSync(ownerPath);
      fs.rmdirSync(gate);
    }
  }

  load(blockchain, { restoreBackup = false } = {}) {
    if (restoreBackup && !this.locked) throw new Error("Восстановление требует блокировки хранилища");
    const source = restoreBackup ? this.backup : this.filename;
    if (!fs.existsSync(source)) {
      if (restoreBackup) throw new Error("Резервная копия не найдена: " + source);
      if (fs.existsSync(this.backup)) throw new Error("Основной файл отсутствует. Для восстановления используйте --restore-backup");
      return false;
    }
    try {
      const contents = fs.readFileSync(source, "utf8");
      blockchain.loadState(JSON.parse(contents));
      this.lastValidContents = contents;
    } catch (error) {
      throw new Error("Не удалось проверить " + source + ": " + error.message + ". История не обнулена.");
    }
    if (restoreBackup) {
      if (fs.existsSync(this.filename)) {
        fs.copyFileSync(this.filename, this.filename + ".before-restore-" + Date.now(), fs.constants.COPYFILE_EXCL);
      }
      atomicWrite(this.filename, this.lastValidContents);
    }
    return true;
  }

  save(blockchain) {
    if (!this.locked) throw new Error("Хранилище не заблокировано");
    const contents = JSON.stringify(blockchain.exportState(), null, 2) + "\n";
    if (this.lastValidContents !== null) atomicWrite(this.backup, this.lastValidContents);
    atomicWrite(this.filename, contents);
    this.lastValidContents = contents;
  }

  release() {
    if (!this.locked) return;
    try {
      const lock = JSON.parse(fs.readFileSync(this.lockfile, "utf8"));
      if (lock.owner === this.owner) fs.unlinkSync(this.lockfile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      this.locked = false;
    }
  }
}

// Address-based ownership also covers copied wallets and different client versions.
// This directory contains only process metadata, never wallet keys.
class WalletLock extends ChainStore {
  constructor(address, filename, root = path.join(os.homedir(), ".friendcoin", "wallet-locks")) {
    super(path.join(root, crypto.createHash("sha256").update(address).digest("hex")));
    this.walletFilename = path.resolve(filename);
  }

  acquire() {
    try { super.acquire(); }
    catch (error) {
      if (/уже используется|захватывает/.test(error.message)) {
        throw new Error("Кошелёк уже используется в другом терминале. Закройте его командой exit и повторите запуск.\nФайл: " + this.walletFilename);
      }
      throw error;
    }
  }
}

module.exports = { atomicWrite, ChainStore, WalletLock };
