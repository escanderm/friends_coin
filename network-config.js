const mainnet = require("./networks/mainnet.json");
const testnet = require("./networks/testnet.json");

function getNetwork(name = "mainnet") {
  if (name === "mainnet") return mainnet;
  if (name === "testnet") return testnet;
  throw new Error("Неизвестная сеть. Используйте mainnet или testnet");
}

module.exports = { getNetwork };
