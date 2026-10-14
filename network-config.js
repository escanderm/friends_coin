const mainnet = require("./networks/mainnet.json");
const testnet = require("./networks/testnet.json");

function getNetwork(name = "mainnet") {
  if (name === "mainnet") return mainnet;
  if (name === "testnet") return testnet;
  if (name === "nft-testnet") return require("./networks/nft-testnet.json");
  throw new Error("Неизвестная сеть. Используйте mainnet, testnet или nft-testnet");
}

module.exports = { getNetwork };
