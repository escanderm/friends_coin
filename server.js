const WebSocket = require("ws");
const { Blockchain, Transaction, Block } = require("./blockchain");
const fs = require("fs");

const server = new WebSocket.Server({ port: 8088 });
const clients = new Map();
let blockchain = null;
let pendingBackup = [];
let users = {};

function loadUsers() {
  try {
    const data = fs.readFileSync("users.json", "utf8");
    users = JSON.parse(data);
    console.log(`📖 Загружено ${Object.keys(users).length} пользователей`);
  } catch (e) {
    console.log("📖 Нет сохранённых пользователей");
  }
}

function saveUsers() {
  fs.writeFileSync("users.json", JSON.stringify(users, null, 2));
}

function loadBlockchain() {
  try {
    const data = fs.readFileSync("blockchain_backup.json", "utf8");
    const savedChain = JSON.parse(data);
    blockchain = new Blockchain();
    blockchain.chain = savedChain.chain;
    blockchain.pendingTransactions = savedChain.pendingTransactions || [];
    console.log(`📂 Загружен блокчейн: ${blockchain.chain.length} блоков`);
    console.log(`   Последний блок #${blockchain.getLastBlock().index}`);
    return true;
  } catch (e) {
    console.log("📂 Нет сохранённого блокчейна");
    return false;
  }
}

function loadPending() {
  try {
    const data = fs.readFileSync("pending_backup.json", "utf8");
    pendingBackup = JSON.parse(data);
    console.log(`📂 Загружено ${pendingBackup.length} транзакций в бэкап`);
  } catch (e) {
    console.log("📂 Нет сохранённых транзакций");
  }
}

function saveBlockchain() {
  if (blockchain) {
    fs.writeFileSync(
      "blockchain_backup.json",
      JSON.stringify(
        {
          chain: blockchain.chain,
          pendingTransactions: blockchain.pendingTransactions,
        },
        null,
        2,
      ),
    );
    console.log(`💾 Блокчейн сохранён (${blockchain.chain.length} блоков)`);
  }
}

function savePending() {
  fs.writeFileSync(
    "pending_backup.json",
    JSON.stringify(pendingBackup, null, 2),
  );
}

function broadcastToAll(message) {
  for (const [name, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}

function broadcastToOthers(sender, message) {
  for (const [name, client] of clients) {
    if (name !== sender && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}

loadUsers();
if (!loadBlockchain()) {
  blockchain = null;
}
loadPending();

console.log("🚀 Сервер запущен на порту 8088");
console.log("💡 Поддерживает восстановление цепочки от клиентов");
console.log("👑 Администратор: AlexanderMikheev");

server.on("connection", (ws) => {
  let clientName = null;
  let clientAddress = null;
  let isAdmin = false;

  ws.on("message", (data) => {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case "register":
        clientName = msg.name;
        clientAddress = msg.address;

        if (!users[clientName]) {
          users[clientName] = clientAddress;
          saveUsers();
          console.log(`📖 Новый пользователь: ${clientName}`);
          broadcastToAll({
            type: "update_users",
            users: users,
          });
        }

        if (!blockchain) {
          blockchain = new Blockchain();
          const genesisTx = new Transaction("SYSTEM", clientAddress, 1000);
          blockchain.chain = [new Block(0, [genesisTx], "0")];
          console.log(`💎 Генезис-блок: ${clientName} получил 1000 монет`);
          saveBlockchain();
        }

        clients.set(clientName, { ws, address: clientAddress });
        console.log(`📡 ${clientName} подключился`);

        // Отправляем всё клиенту
        ws.send(
          JSON.stringify({
            type: "sync",
            chain: blockchain.chain,
            users: users,
            pendingBackup: pendingBackup,
          }),
        );
        break;

      case "admin_register":
        clientName = msg.name;
        if (clientName === "AlexanderMikheev") {
          isAdmin = true;
          if (clients.has(clientName)) {
            clients.get(clientName).isAdmin = true;
          }
          console.log(`👑 Администратор ${clientName} подключился`);
          ws.send(
            JSON.stringify({
              type: "admin_response",
              message: "✅ Вы вошли как администратор",
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "admin_response",
              message: "❌ У вас нет прав администратора",
            }),
          );
        }
        break;

      case "admin_mint":
        if (!isAdmin && clientName !== "AlexanderMikheev") {
          ws.send(
            JSON.stringify({
              type: "admin_response",
              message: "❌ У вас нет прав администратора",
            }),
          );
          break;
        }

        if (!users[msg.to]) {
          ws.send(
            JSON.stringify({
              type: "admin_response",
              message: `❌ Пользователь "${msg.to}" не найден. Сначала он должен запустить клиент.`,
            }),
          );
          break;
        }

        const mintTx = new Transaction("SYSTEM", users[msg.to], msg.amount);
        mintTx.signature = `admin_mint_${Date.now()}`;

        pendingBackup.push(mintTx);
        savePending();

        const txMessage = {
          type: "new_transaction",
          tx: {
            from: "SYSTEM",
            to: users[msg.to],
            amount: msg.amount,
            timestamp: Date.now(),
            signature: mintTx.signature,
          },
        };

        // Рассылаем всем клиентам
        for (const [name, client] of clients) {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(txMessage));
          }
        }

        ws.send(
          JSON.stringify({
            type: "admin_response",
            message: `✅ Выпущено ${msg.amount} монет для ${msg.to}`,
          }),
        );
        console.log(`💰 Админ выпустил ${msg.amount} монет для ${msg.to}`);
        break;

      case "request_pending":
        ws.send(
          JSON.stringify({
            type: "pending_update",
            pendingBackup: pendingBackup,
          }),
        );
        break;

      case "submit_chain":
        console.log(
          `📤 ${clientName} предлагает цепочку из ${msg.chain.length} блоков`,
        );

        if (!blockchain || blockchain.chain.length < msg.chain.length) {
          blockchain = new Blockchain();
          blockchain.chain = msg.chain;
          blockchain.pendingTransactions = msg.pendingTransactions || [];
          saveBlockchain();

          pendingBackup = blockchain.pendingTransactions;
          savePending();

          console.log(
            `   ✅ Цепочка принята! Теперь ${blockchain.chain.length} блоков`,
          );

          broadcastToAll({
            type: "force_sync",
            chain: blockchain.chain,
            pendingBackup: pendingBackup,
          });
        } else {
          console.log(`   ⏸️ Цепочка отклонена (моя длиннее или равна)`);
        }
        break;

      case "new_transaction":
        console.log(
          `💸 Транзакция от ${msg.tx.from.substring(0, 16)}... на ${msg.tx.amount} монет`,
        );

        pendingBackup.push(msg.tx);
        savePending();

        broadcastToOthers(clientName, msg);
        break;

      case "new_block":
        console.log(`📦 Новый блок #${msg.block.index} от ${clientName}`);

        if (blockchain) {
          const lastBlock = blockchain.getLastBlock();
          if (msg.block.previousHash === lastBlock.hash) {
            blockchain.chain.push(msg.block);

            const txKeys = msg.block.transactions.map((tx) =>
              JSON.stringify(tx),
            );
            pendingBackup = pendingBackup.filter(
              (tx) => !txKeys.includes(JSON.stringify(tx)),
            );

            saveBlockchain();
            savePending();

            console.log(
              `   ✅ Блок принят. В цепочке ${blockchain.chain.length} блоков`,
            );
          } else {
            console.log(`   ❌ Блок отклонён: previousHash не совпадает`);
          }
        } else {
          console.log(`   ❌ Блок отклонён: нет блокчейна`);
        }

        broadcastToOthers(clientName, msg);
        break;
    }
  });

  ws.on("close", () => {
    if (clientName) {
      clients.delete(clientName);
      console.log(`📡 ${clientName} отключился`);
    }
  });
});

process.on("SIGINT", () => {
  console.log("\n💾 Сохраняем...");
  if (blockchain) saveBlockchain();
  savePending();
  saveUsers();
  process.exit();
});
