const EventEmitter = require("events");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const { Blockchain, Transaction } = require("./blockchain");
const { Wallet } = require("./wallet");
const { getNetwork } = require("./network-config");
const { ChainStore } = require("./storage");
const { resolveServerConfig, validateServerUrl } = require("./server-config");
const { parseAmountUnits, formatAmountUnits, isAddress, transactionId } = require("./protocol");
const { PROTOCOL_VERSION, parseMessage, signIdentity, verifyIdentity, validatePeerMessage, tipOf, boundedBlocksMessage } = require("./peer-protocol");
const { version } = require("./package.json");

class User extends EventEmitter {
  constructor(name, serverUrl = null, walletPath = null, options = {}) {
    super();
    this.name = name;
    const configured = serverUrl === null ? resolveServerConfig({ argv: [], cwd: options.dataDir || process.cwd() }).serverUrl : serverUrl;
    if (!configured) throw new Error("Адрес сервера не настроен. Используйте --server ws://адрес:8088");
    this.serverUrl = validateServerUrl(configured);
    this.serverUrls = [...new Set([this.serverUrl, ...(options.relays || []).map(validateServerUrl)])];
    this.walletPath = walletPath;
    this.wallet = options.wallet || null;
    this.network = options.network || getNetwork("mainnet");
    this.blockchain = new Blockchain(this.network);
    this.options = options;
    this.dataDir = path.resolve(options.dataDir || "friendcoin-data");
    this.store = null;
    this.ws = null;
    this.ready = false;
    this.peers = new Map();
    this.connections = new Map();
    this.requests = new Map();
    this.retries = new Map();
    this.closing = false;
    this.storageFailed = false;
    this.mining = null;
    this.miningStatus = null;
    this.sweep = null;
    this.log = options.logger || (message => console.log(String(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, 2000)));
  }

  async init({ password, restoreBackup = false } = {}) {
    if (!this.wallet) {
      if (!this.walletPath) throw new Error("Сначала выберите или создайте кошелёк");
      this.wallet = new Wallet(this.name);
      this.wallet.load(this.walletPath, password);
    }
    this.name = this.wallet.name;
    this.store = new ChainStore(path.join(this.dataDir, this.network.networkId));
    this.store.acquire();
    try {
      this.store.load(this.blockchain, { restoreBackup });
      this.store.save(this.blockchain);
    } catch (error) { this.store.release(); this.store = null; throw error; }
    this.sweep = setInterval(() => {
      this._expireRequests();
      this._updateReady();
    }, 1000);
    this.sweep.unref();
    await this.connect();
    return this;
  }

  _updateReady() {
    const connected = [...this.connections.values()].some(connection => connection.identified);
    const synchronizing = [...this.requests.values()].some(request => request.type === "blocks");
    const wasReady = this.ready;
    this.ready = connected && !synchronizing && !this.storageFailed && !this.closing;
    if (this.ready && !wasReady) this.emit("ready");
  }

  _expireRequests(now = Date.now()) {
    for (const [id, request] of this.requests) {
      if (request.expires >= now) continue;
      this.requests.delete(id);
      if (request.reportPool) this.emit("poolSync", { status: "timeout", remaining: this._pendingPoolReports() });
    }
  }

  _pendingPoolReports() {
    return [...this.requests.values()].filter(request => request.reportPool).length;
  }

  syncPool() {
    let requested = 0;
    for (const peer of this.peers.values()) {
      const id = this._request(peer.url, peer.id, "pool");
      if (id) { this.requests.get(id).reportPool = true; requested++; }
    }
    if (!requested) throw new Error("Нет доступных узлов для синхронизации пула. Проверьте подключение командой info");
    return requested;
  }

  async connect() {
    if ([...this.connections.values()].some(connection => connection.identified)) return;
    const promise = new Promise((resolve, reject) => {
      const onConnected = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(() => {
        this.removeListener("connected", onConnected);
        reject(new Error("Сервер не ответил по протоколу 2. Проверьте адрес и совместимость версии"));
      }, this.options.connectTimeout || 6000);
      this.once("connected", onConnected);
    });
    for (const url of this.serverUrls) this._open(url);
    return promise;
  }

  _open(url) {
    if (this.closing) return;
    const previous = this.connections.get(url);
    if (previous && previous.socket.readyState <= WebSocket.OPEN) return;
    const socket = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 1024 * 1024, perMessageDeflate: false });
    const connection = { socket, id: null, identified: false, phase: "hello", handshake: null };
    this.connections.set(url, connection);
    if (!this.ws) this.ws = socket;
    connection.handshake = setTimeout(() => {
      if (!connection.identified) socket.terminate();
    }, 5000);
    socket.on("open", () => {
      this._send(url, { type: "hello", protocolVersion: PROTOCOL_VERSION, clientVersion: version, networkId: this.network.networkId, genesisHash: this.blockchain.chain[0].hash });
    });
    socket.on("message", data => {
      try { this._handle(url, parseMessage(data)); }
      catch (error) {
        this.log("Отклонено сообщение: " + error.message);
        if (!connection.identified) socket.close(1008, "Invalid handshake");
      }
    });
    socket.on("error", error => this.log("Подключение " + url + ": " + error.message));
    socket.on("close", () => {
      clearTimeout(connection.handshake);
      if (this.connections.get(url) !== connection) return;
      this.connections.delete(url);
      if (this.ws === socket) this.ws = [...this.connections.values()][0]?.socket || null;
      for (const [key, peer] of this.peers) if (peer.url === url) this.peers.delete(key);
      for (const [id, request] of this.requests) if (request.url === url) {
        this.requests.delete(id);
        if (request.reportPool) this.emit("poolSync", { status: "disconnected", remaining: this._pendingPoolReports() });
      }
      this._updateReady();
      if (!this.ready && this.mining) this.mining.abort();
      this.emit("disconnected", url);
      if (!this.closing && this.options.reconnect !== false) {
        const retry = this.retries.get(url) || { attempt: 0, timer: null };
        retry.attempt++;
        retry.timer = setTimeout(() => this._open(url), Math.min(30000, 1000 * 2 ** Math.min(5, retry.attempt - 1)));
        this.retries.set(url, retry);
      }
    });
  }

  _send(url, message) {
    const connection = this.connections.get(url);
    if (connection && connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  _broadcast(message, excludedUrl = null) {
    for (const [url, connection] of this.connections) {
      if (connection.identified && url !== excludedUrl) this._send(url, message);
    }
  }

  _save() {
    if (this.store) {
      try { this.store.save(this.blockchain); }
      catch (error) {
        this.storageFailed = true;
        this.ready = false;
        this.stopMining();
        this.emit("storageError", error);
        throw error;
      }
    }
    this.emit("state", tipOf(this.blockchain));
  }

  _announce() { this._broadcast({ type: "announce", tip: tipOf(this.blockchain) }); }

  _request(url, peerId, type, locator = null) {
    for (const [id, request] of this.requests) {
      if (request.url === url && request.peerId === peerId && request.type === type) return id;
    }
    if (this.requests.size >= 128) return;
    const requestId = crypto.randomUUID();
    const selectedLocator = locator || this.blockchain.getLocator();
    this.requests.set(requestId, { url, peerId, type, locator: selectedLocator, expires: Date.now() + 10000 });
    const message = type === "blocks"
      ? { type: "request_blocks", to: peerId, requestId, locator: selectedLocator, limit: 16 }
      : { type: "request_pool", to: peerId, requestId };
    if (!this._send(url, message)) this.requests.delete(requestId);
    this._updateReady();
    return this.requests.has(requestId) ? requestId : null;
  }

  _updatePeers(url, peers) {
    if (!Array.isArray(peers) || peers.length > 129) throw new Error("Неверный список узлов");
    const connection = this.connections.get(url);
    for (const [key, peer] of this.peers) if (peer.url === url) this.peers.delete(key);
    for (const peer of peers) {
      if (!peer || typeof peer.id !== "string" || peer.id.length > 100 || peer.id === connection.id) continue;
      if (peer.archive === true) {
        if (peer.id !== "archive" || peer.identity !== undefined || peer.challenge !== undefined) continue;
      } else if (!verifyIdentity(peer.identity, this.network.networkId, peer.challenge)) continue;
      this.peers.set(url + "|" + peer.id, { ...peer, url });
      if (peer.tip && peer.tip.hash !== this.blockchain.getLastBlock().hash) this._request(url, peer.id, "blocks");
    }
    this.emit("peers", [...this.peers.values()]);
  }

  _handle(url, message) {
    const connection = this.connections.get(url);
    if (!connection) return;
    if (message.type === "welcome") {
      if (connection.phase !== "hello") throw new Error("Повторное приветствие сервера");
      if (message.protocolVersion !== PROTOCOL_VERSION || message.networkId !== this.network.networkId || message.genesisHash !== this.blockchain.chain[0].hash || typeof message.challenge !== "string" || !/^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/.test(message.challenge) || typeof message.peerId !== "string") throw new Error("Несовместимый сервер");
      connection.id = message.peerId;
      connection.phase = "identify";
      this._send(url, { type: "identify", identity: signIdentity(this.wallet, this.network.networkId, message.challenge) });
      return;
    }
    if (message.type === "incompatible") {
      this.log(message.message || "Несовместимая сеть");
      connection.socket.close();
      return;
    }
    if (message.type === "error") { this.log("Сервер: " + message.message); return; }
    if (message.type === "identified") {
      if (connection.phase !== "identify" || message.peerId !== connection.id) throw new Error("Неверная регистрация узла");
      this._updatePeers(url, message.peers);
      clearTimeout(connection.handshake);
      connection.identified = true;
      connection.phase = "identified";
      const retry = this.retries.get(url);
      if (retry?.timer) clearTimeout(retry.timer);
      this.retries.delete(url);
      this._announce();
      for (const peer of this.peers.values()) if (peer.url === url) this._request(url, peer.id, "pool");
      this._updateReady();
      this.log("Подключено: " + url + " | " + this.network.networkId);
      this.emit("connected", url);
      return;
    }
    if (!connection.identified) throw new Error("Сообщение до регистрации");
    if (message.type === "peers") { this._updatePeers(url, message.peers); return; }
    validatePeerMessage(message);
    if (typeof message.from !== "string") throw new Error("Неизвестный отправитель");
    switch (message.type) {
      case "announce":
        if (message.from !== connection.id && message.tip?.hash !== this.blockchain.getLastBlock().hash) this._request(url, message.from, "blocks");
        break;
      case "request_blocks":
        this._send(url, boundedBlocksMessage({ to: message.from, requestId: message.requestId, tip: tipOf(this.blockchain) }, this.blockchain.getBlocksAfter(message.locator, message.limit)));
        break;
      case "request_pool":
        this._send(url, { type: "pool", to: message.from, requestId: message.requestId, transactions: this.blockchain.pendingTransactions.slice(0, 100), tip: tipOf(this.blockchain) });
        break;
      case "blocks": {
        const request = this.requests.get(message.requestId);
        if (!request || request.url !== url || request.peerId !== message.from || request.type !== "blocks") return;
        this.requests.delete(message.requestId);
        let accepted = false;
        let lastVerifiedHash = null;
        for (const block of message.blocks) {
          const result = this.blockchain.receiveBlock(block);
          if (result.missingParent) break;
          lastVerifiedHash = block.hash;
          accepted = result.accepted || accepted;
          if (result.accepted) this._save();
        }
        if (accepted) this._announce();
        const lastHash = lastVerifiedHash;
        if (lastHash && lastHash !== request.locator[0] && message.tip?.hash !== lastHash && !this.blockchain.hasBlock(message.tip?.hash)) {
          this._request(url, message.from, "blocks", [lastHash, ...this.blockchain.getLocator()].slice(0, 64));
        } else {
          this._request(url, message.from, "pool");
        }
        this._updateReady();
        break;
      }
      case "pool": {
        const request = this.requests.get(message.requestId);
        if (!request || request.url !== url || request.peerId !== message.from || request.type !== "pool") return;
        this.requests.delete(message.requestId);
        let added = 0;
        for (const transaction of message.transactions) {
          try { this.blockchain.addTransaction(transaction); added++; } catch { /* Duplicate or incompatible pending transfer. */ }
        }
        this._save();
        this._updateReady();
        if (request.reportPool) this.emit("poolSync", {
          status: "received", received: message.transactions.length, added,
          pending: this.blockchain.pendingTransactions.length, remaining: this._pendingPoolReports(),
        });
        break;
      }
      case "transaction":
        try {
          const transaction = this.blockchain.addTransaction(message.transaction);
          this._save();
          this._broadcast({ type: "transaction", transaction }, url);
          this.emit("transaction", transaction);
        } catch (error) {
          if (error.code !== "DUPLICATE_TRANSACTION") this.log("Перевод отклонён: " + error.message);
        }
        break;
      case "block": {
        const result = this.blockchain.receiveBlock(message.block);
        if (result.missingParent) { this._request(url, message.from, "blocks"); break; }
        if (result.accepted) {
          this._save();
          this._broadcast({ type: "block", block: message.block }, url);
        }
        if (result.tipChanged) {
          this._announce();
          this.emit("block", message.block);
        }
        break;
      }
    }
  }

  resolveRecipient(input) {
    if (isAddress(input)) return input;
    const matches = new Set([...this.peers.values()].filter(peer => peer.identity?.name === input).map(peer => peer.identity.address));
    if (matches.size !== 1) throw new Error(matches.size ? "Имя неоднозначно. Укажите полный адрес" : "Друг не найден. Укажите его полный адрес");
    return [...matches][0];
  }

  sendCoins(recipient, amount, fee = null) {
    if (!this.ready) throw new Error("Подождите подключения и синхронизации");
    const to = this.resolveRecipient(recipient);
    const amountUnits = parseAmountUnits(String(amount));
    const feeUnits = fee === null ? this.network.minFeeUnits : parseAmountUnits(String(fee));
    const transaction = new Transaction({ version: 2, networkId: this.network.networkId, from: this.wallet.address, to, amountUnits, feeUnits, nonce: this.blockchain.getNextNonce(this.wallet.address), publicKey: this.wallet.keys.publicKey, timestamp: Date.now(), signature: null });
    this.wallet.signTransaction(transaction);
    const accepted = this.blockchain.addTransaction(transaction);
    this._save();
    this._broadcast({ type: "transaction", transaction: accepted });
    this.emit("transaction", accepted);
    return { transaction: accepted, id: transactionId(accepted) };
  }

  async mine() {
    if (!this.ready) throw new Error("Подождите подключения и синхронизации");
    if (this.mining) throw new Error("Майнинг уже запущен");
    const controller = new AbortController();
    this.mining = controller;
    this.miningStatus = { height: this.blockchain.getLastBlock().height + 1, nonce: 0, hashrate: 0, elapsedMs: 0 };
    try {
      this.emit("miningStarted", this.miningStatus);
      const block = await this.blockchain.mineBlock(this.wallet.address, {
        signal: controller.signal,
        onProgress: progress => {
          this.miningStatus = { ...this.miningStatus, ...progress };
          this.emit("miningProgress", this.miningStatus);
        },
      });
      if (!block) return null;
      this._save();
      this._broadcast({ type: "block", block });
      this._announce();
      this.emit("block", block);
      return block;
    } finally {
      if (this.mining === controller) { this.mining = null; this.miningStatus = null; }
    }
  }

  stopMining() { if (this.mining) this.mining.abort(); }

  showBalance() {
    const total = this.blockchain.getBalanceUnits(this.wallet.address);
    const available = this.blockchain.getAvailableBalanceUnits(this.wallet.address);
    this.log("Баланс: " + formatAmountUnits(total) + " FC | доступно: " + formatAmountUnits(available) + " FC");
    return { total, available };
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.ready = false;
    this.stopMining();
    if (this.sweep) clearInterval(this.sweep);
    for (const retry of this.retries.values()) if (retry.timer) clearTimeout(retry.timer);
    this.retries.clear();
    for (const connection of this.connections.values()) { clearTimeout(connection.handshake); connection.socket.terminate(); }
    this.connections.clear();
    this.requests.clear();
    if (this.store) {
      try { this.store.save(this.blockchain); } finally { this.store.release(); this.store = null; }
    }
  }
}

module.exports = { User };
