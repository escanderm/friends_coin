const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const WebSocket = require("ws");
const { Blockchain } = require("./blockchain");
const { normalizeTransaction, HASH_PATTERN } = require("./protocol");
const { ChainStore } = require("./storage");
const { getNetwork } = require("./network-config");
const { parseArguments, resolveDataDirectory, portNumber } = require("./cli");
const {
  PROTOCOL_VERSION, MAX_PAYLOAD, verifyIdentity, parseMessage, validatePeerMessage, tipOf,
} = require("./peer-protocol");

const SERVER_VERSION = require("./package.json").version;
const RELEASES_URL = "https://github.com/escanderm/friends_coin/releases";
const RATE_WINDOW_MS = 10000;
const MAX_MESSAGES = 100;
const MAX_BYTES = 4 * MAX_PAYLOAD;
const MAX_PEERS = 128;
const MAX_PENDING_REQUESTS = 64;
const MAX_ORPHANS = 128;
const MAX_POOL = 1000;
const REQUEST_TIMEOUT_MS = 20000;
const DOWNLOADS = new Set([
  "friendcoin-macos-arm64", "friendcoin-macos-x64", "friendcoin-linux-x64", "friendcoin-windows-x64.exe",
]);

function validateTip(tip) {
  if (
    !tip || typeof tip !== "object" || Array.isArray(tip) ||
    typeof tip.hash !== "string" || !HASH_PATTERN.test(tip.hash) || !Number.isSafeInteger(tip.height) || tip.height < 0 ||
    typeof tip.chainwork !== "string" || !/^(0|[1-9][0-9]{0,99})$/.test(tip.chainwork) ||
    Object.keys(tip).some(key => !["hash", "height", "chainwork"].includes(key))
  ) throw new Error("Неверная вершина цепи");
  return { hash: tip.hash, height: tip.height, chainwork: tip.chainwork };
}

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify(message);
  if (Buffer.byteLength(data) > MAX_PAYLOAD || ws.bufferedAmount > MAX_BYTES) {
    ws.close(1009, "Outgoing message limit");
    return;
  }
  ws.send(data, error => { if (error) ws.terminate(); });
}

function downloadHandler(buildsDir) {
  return (req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return;
    }
    if (req.url === "/download" || req.url === "/download/") {
      const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>FriendCoin downloads</title><h1>FriendCoin ${SERVER_VERSION}</h1><p><a href="${RELEASES_URL}">Download verified release assets on GitHub</a></p></html>`;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(page),
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : page); return;
    }
    const filename = req.url?.startsWith("/download/") ? req.url.slice(10) : "";
    if (!buildsDir || !DOWNLOADS.has(filename)) { res.writeHead(404); res.end("Not found"); return; }
    const filePath = path.join(buildsDir, filename);
    let stat;
    let descriptor;
    try {
      stat = fs.lstatSync(filePath);
      if (!stat.isFile()) throw new Error("Not a regular artifact");
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error("Not a regular artifact");
    } catch {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      res.writeHead(404); res.end("Not found"); return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": stat.size,
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") { fs.closeSync(descriptor); res.end(); return; }
    const stream = fs.createReadStream(filePath, { fd: descriptor, autoClose: true });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  };
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.removeListener("listening", onListening); reject(error); };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    if (options) server.listen(options);
  });
}

async function createServer({
  network = getNetwork("mainnet"), dataDir = resolveDataDirectory(), host = "127.0.0.1",
  port = 8088, downloadPort = null, archive = true, buildsDir = null, restoreBackup = false,
} = {}) {
  const initial = new Blockchain(network);
  network = initial.network;
  if (!archive && restoreBackup) throw new Error("--restore-backup требует архивный узел");
  const ledger = archive ? initial : null;
  const store = archive ? new ChainStore(path.join(path.resolve(dataDir), network.networkId)) : null;
  const peers = new Map();
  const pending = new Map();
  const orphans = new Map();
  let wss;
  let downloads;
  let heartbeat;
  let closing = false;
  let closePromise;

  function peerList() {
    const list = Array.from(peers.values(), peer => ({ id: peer.id, identity: peer.identity, challenge: peer.challenge, tip: peer.tip }));
    if (archive) list.push({ id: "archive", archive: true, name: "Archive", tip: tipOf(ledger) });
    return list;
  }
  function broadcast(message, exceptId) {
    for (const peer of peers.values()) if (peer.id !== exceptId) send(peer.ws, message);
  }
  function updatePeers(exceptId) { broadcast({ type: "peers", peers: peerList() }, exceptId); }
  function expireRequests() {
    const now = Date.now();
    for (const [id, request] of pending) if (request.expires <= now) pending.delete(id);
    for (const [hash, orphan] of orphans) if (orphan.expires <= now) orphans.delete(hash);
  }
  function archiveRequest(peer, type, locator = null) {
    expireRequests();
    if (!archive || pending.size >= MAX_PENDING_REQUESTS || peer.ws.readyState !== WebSocket.OPEN) return;
    if (Array.from(pending.values()).some(request => request.peerId === peer.id && request.type === type)) return;
    const requestId = crypto.randomUUID();
    pending.set(requestId, { peerId: peer.id, type, expires: Date.now() + REQUEST_TIMEOUT_MS });
    send(peer.ws, {
      type: type === "blocks" ? "request_blocks" : "request_pool", from: "archive", to: peer.id, requestId,
      ...(type === "blocks" ? { locator: locator || ledger.getLocator(), limit: 16 } : {}),
    });
  }
  function rejectPeer(peer, error) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      send(peer.ws, { type: "error", code: "PROTOCOL_ERROR", message: error.message || "Неверное сообщение" });
      peer.ws.close(1008, "Invalid protocol message");
    }
  }
  function saveArchive(tipChanged = false) {
    try { store.save(ledger); }
    catch (error) {
      void close().catch(() => {});
      throw new Error("Не удалось сохранить архив. Узел остановлен, история не обнулена");
    }
    if (tipChanged) {
      broadcast({ type: "announce", from: "archive", tip: tipOf(ledger) });
      updatePeers();
    }
  }
  function rememberOrphan(peer, block) {
    expireRequests();
    if (!orphans.has(block.hash) && orphans.size >= MAX_ORPHANS) throw new Error("Слишком много блоков без родителей");
    orphans.set(block.hash, { block, peerId: peer.id, expires: Date.now() + REQUEST_TIMEOUT_MS });
  }
  function receiveArchiveBlock(peer, block, requestMissing = true) {
    const result = ledger.receiveBlock(block);
    if (result.missingParent) {
      rememberOrphan(peer, block);
      if (requestMissing) archiveRequest(peer, "blocks");
      return;
    }
    if (result.accepted) saveArchive(result.tipChanged);
    let progress = true;
    while (progress) {
      progress = false;
      for (const [hash, orphan] of orphans) {
        if (!ledger.hasBlock(orphan.block.previousHash)) continue;
        orphans.delete(hash);
        const source = peers.get(orphan.peerId);
        try {
          const applied = ledger.receiveBlock(orphan.block);
          if (applied.accepted) { saveArchive(applied.tipChanged); progress = true; }
        } catch (error) { if (source) rejectPeer(source, error); }
      }
    }
  }
  function receiveArchiveTransaction(transaction) {
    if (ledger.pendingTransactions.length >= MAX_POOL) return;
    try {
      ledger.addTransaction(transaction);
      saveArchive();
    } catch (error) {
      // Peers can be ahead of this archive or replay a transaction already received.
      if (!["DUPLICATE_TRANSACTION", "BAD_NONCE", "INSUFFICIENT_FUNDS"].includes(error.code)) throw error;
    }
  }
  function validateContents(message) {
    if (message.type === "announce") message.tip = validateTip(message.tip);
    if (message.type === "transaction") normalizeTransaction(message.transaction, network);
    if (message.type === "pool") for (const tx of message.transactions) normalizeTransaction(tx, network);
    if (message.type === "blocks" || (message.type === "pool" && message.tip !== undefined)) message.tip = validateTip(message.tip);
    if (["block", "blocks"].includes(message.type)) {
      // Stateless validation on a temporary ledger keeps relay mode independent of chain state.
      const validator = new Blockchain(network);
      for (const block of message.type === "block" ? [message.block] : message.blocks) validator.receiveBlock(block);
    }
  }
  function archiveMessage(peer, message) {
    if (message.type === "request_blocks") {
      send(peer.ws, { type: "blocks", from: "archive", to: peer.id, requestId: message.requestId,
        blocks: ledger.getBlocksAfter(message.locator, Math.min(message.limit, 16)), tip: tipOf(ledger) });
    } else if (message.type === "request_pool") {
      send(peer.ws, { type: "pool", from: "archive", to: peer.id, requestId: message.requestId,
        transactions: ledger.pendingTransactions.slice(0, 100).map(tx => tx.toJSON()), tip: tipOf(ledger) });
    } else if (["blocks", "pool"].includes(message.type)) {
      expireRequests();
      const request = pending.get(message.requestId);
      if (!request || request.peerId !== peer.id || request.type !== message.type) throw new Error("Незапрошенный ответ архиву");
      pending.delete(message.requestId);
      if (message.type === "blocks") {
        for (const block of message.blocks) receiveArchiveBlock(peer, block, false);
        if (message.blocks.length && !ledger.hasBlock(message.tip.hash)) {
          const last = message.blocks.at(-1);
          const locator = ledger.hasBlock(last.hash)
            ? [...new Set([last.hash, ...ledger.getLocator()])].slice(0, 64) : ledger.getLocator();
          archiveRequest(peer, "blocks", locator);
        } else if (ledger.hasBlock(message.tip.hash)) archiveRequest(peer, "pool");
      } else {
        for (const transaction of message.transactions) receiveArchiveTransaction(transaction);
      }
    } else if (message.type === "announce") {
      if (!ledger.hasBlock(message.tip.hash)) archiveRequest(peer, "blocks");
    } else if (message.type === "transaction") {
      receiveArchiveTransaction(message.transaction);
    } else if (message.type === "block") {
      receiveArchiveBlock(peer, message.block);
    }
  }
  function identifiedMessage(peer, message) {
    if (message.from !== undefined) throw new Error("Отправитель назначается relay-сервером");
    validatePeerMessage(message);
    if (["request_blocks", "blocks", "request_pool", "pool"].includes(message.type) && !message.to) {
      throw new Error("Для запроса или ответа нужен получатель to");
    }
    validateContents(message);
    if (message.type === "announce") { peer.tip = message.tip; updatePeers(peer.id); }
    if (archive && (!message.to || message.to === "archive")) archiveMessage(peer, message);
    const forwarded = { ...message, from: peer.id };
    if (message.to) {
      if (message.to === "archive") {
        if (!archive) send(peer.ws, { type: "error", code: "PEER_UNAVAILABLE", message: "Архив отключён", requestId: message.requestId });
      } else {
        const destination = peers.get(message.to);
        if (destination) send(destination.ws, forwarded);
        else send(peer.ws, { type: "error", code: "PEER_UNAVAILABLE", message: "Получатель отключён", requestId: message.requestId });
      }
    } else broadcast(forwarded, peer.id);
  }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      clearInterval(heartbeat);
      pending.clear(); orphans.clear();
      if (wss) for (const ws of wss.clients) { clearTimeout(ws.handshakeTimer); ws.terminate(); }
      const operations = [];
      if (downloads?.listening) operations.push(new Promise(resolve => { downloads.close(resolve); downloads.closeAllConnections?.(); }));
      if (wss) operations.push(new Promise(resolve => wss.close(() => resolve())));
      try { await Promise.all(operations); } finally { store?.release(); }
    })();
    return closePromise;
  }

  try {
    if (store) { store.acquire(); if (!store.load(ledger, { restoreBackup })) store.save(ledger); }
    wss = new WebSocket.Server({ host, port, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    wss.on("connection", ws => {
      if (closing || wss.clients.size > MAX_PEERS) { ws.terminate(); return; }
      const peer = { ws, id: crypto.randomUUID(), challenge: crypto.randomBytes(32).toString("hex"),
        identity: null, tip: null, phase: "hello", windowStart: Date.now(), messages: 0, bytes: 0 };
      ws.isAlive = true;
      ws.handshakeTimer = setTimeout(() => ws.close(1008, "Handshake timeout"), 10000);
      ws.handshakeTimer.unref();
      ws.on("pong", () => { ws.isAlive = true; });
      ws.on("error", () => { if (ws.readyState === WebSocket.OPEN) ws.close(1011, "WebSocket error"); });
      ws.on("message", (data, isBinary) => {
        try {
          if (closing || ws.readyState !== WebSocket.OPEN) return;
          if (isBinary) throw new Error("Протокол принимает только текстовый JSON");
          if (Date.now() - peer.windowStart >= RATE_WINDOW_MS) { peer.windowStart = Date.now(); peer.messages = 0; peer.bytes = 0; }
          peer.messages += 1; peer.bytes += data.length;
          if (peer.messages > MAX_MESSAGES || peer.bytes > MAX_BYTES) throw new Error("Превышен лимит сообщений");
          const message = parseMessage(data);
          if (peer.phase === "hello") {
            if (message.type !== "hello" || message.protocolVersion !== PROTOCOL_VERSION ||
              message.networkId !== network.networkId || message.genesisHash !== initial.genesisHash ||
              Object.keys(message).some(key => !["type", "protocolVersion", "networkId", "genesisHash", "clientVersion"].includes(key))) {
              throw new Error("Несовместимый протокол, сеть или генезис");
            }
            peer.phase = "identify";
            send(ws, { type: "welcome", peerId: peer.id, challenge: peer.challenge, protocolVersion: PROTOCOL_VERSION,
              networkId: network.networkId, genesisHash: initial.genesisHash, serverVersion: SERVER_VERSION });
          } else if (peer.phase === "identify") {
            if (message.type !== "identify" || Object.keys(message).some(key => !["type", "identity"].includes(key)) ||
              !message.identity || typeof message.identity.name !== "string" || Object.keys(message.identity).some(key => !["name", "address", "publicKey", "signature"].includes(key)) ||
              !verifyIdentity(message.identity, network.networkId, peer.challenge)) throw new Error("Не удалось подтвердить личность ключом");
            peer.identity = message.identity; peer.phase = "identified";
            clearTimeout(ws.handshakeTimer); peers.set(peer.id, peer);
            send(ws, { type: "identified", peerId: peer.id, peers: peerList() });
            updatePeers(peer.id);
            if (archive) archiveRequest(peer, "pool");
          } else identifiedMessage(peer, message);
        } catch (error) { rejectPeer(peer, error); }
      });
      ws.on("close", () => {
        clearTimeout(ws.handshakeTimer);
        const existed = peers.delete(peer.id);
        for (const [id, request] of pending) if (request.peerId === peer.id) pending.delete(id);
        for (const [hash, orphan] of orphans) if (orphan.peerId === peer.id) orphans.delete(hash);
        if (existed && !closing) updatePeers();
      });
    });
    await listen(wss);
    wss.on("error", () => { void close().catch(() => {}); });
    if (downloadPort !== null) {
      downloads = http.createServer(downloadHandler(buildsDir ? path.resolve(buildsDir) : null));
      await listen(downloads, { host, port: downloadPort });
      downloads.on("error", () => { void close().catch(() => {}); });
    }
    heartbeat = setInterval(() => {
      expireRequests();
      for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        if (ws.readyState === WebSocket.OPEN) { ws.isAlive = false; ws.ping(); }
      }
    }, 30000);
    heartbeat.unref();
    return { wss, ledger, store, address: wss.address(), downloadAddress: downloads?.address() || null, close };
  } catch (error) { await close(); throw error; }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv, ["network", "data-dir", "host", "port", "download-port"],
    ["relay-only", "restore-backup", "version", "help"]);
  if (options.version) { console.log(SERVER_VERSION); return; }
  if (options.help) {
    console.log("FriendCoin relay + optional archive\nUsage: node server.js [--network mainnet|testnet] [--data-dir PATH] [--host ADDRESS] [--port PORT] [--download-port PORT] [--relay-only] [--restore-backup]\n--version  Show application version\n--help     Show help");
    return;
  }
  const instance = await createServer({
    network: getNetwork(options.network || "mainnet"), dataDir: resolveDataDirectory(options["data-dir"]),
    host: options.host || "127.0.0.1", port: portNumber(options.port, 8088),
    downloadPort: options["download-port"] === undefined ? null : portNumber(options["download-port"], 8089),
    archive: !options["relay-only"], restoreBackup: !!options["restore-backup"], buildsDir: path.join(__dirname, "builds"),
  });
  console.log(`FriendCoin ${SERVER_VERSION}: protocol ${PROTOCOL_VERSION}, ${instance.ledger ? "relay + archive" : "relay only"}, ${options.host || "127.0.0.1"}:${instance.address.port}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    instance.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  return instance;
}

if (require.main === module) main().catch(error => { console.error(`Ошибка запуска: ${error.message}`); process.exitCode = 1; });
module.exports = { createServer, main, SERVER_VERSION, RELEASES_URL };
