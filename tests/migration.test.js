"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Blockchain } = require("../blockchain");
const { COIN, addressFromPublicKey } = require("../protocol");
const checkpoint = require("../networks/legacy-checkpoint.json");
const mainnet = require("../networks/mainnet.json");
const testnet = require("../networks/testnet.json");

// Pin the reviewed checkpoint balances and recipients independently of config.
const expected = [
  ["FC2_6ea6b18333bc10a21091767d8f73fef7f7cb2261d858d16f047817a0b57cf373_f60cd811", 55200],
  ["FC2_3f72cc90512deaba6913afbbdcace882494c13f605e2648b7d6d9664532a92c5_b77e82cd", 200000],
  ["FC2_600bbe0fcf76b724489008eb5999f1efb67d6c0752b61652e915dc69b9b1218c_442d97a1", 200],
];

test("legacy checkpoint preserves all three owners and 255400 units only on mainnet", () => {
  assert.equal(COIN, 100);
  assert.equal(checkpoint.allocations.length, 3);
  assert.equal(checkpoint.supplyUnits, 255400);
  const chain = new Blockchain(mainnet), otherNetwork = new Blockchain(testnet);
  const allocations = new Map(mainnet.genesis.allocations.map(value => [value.address, value.amountUnits]));
  assert.equal(mainnet.genesis.allocations.length, 3);
  assert.equal(allocations.size, 3);
  assert.deepEqual(mainnet.genesis.legacyCheckpoint, { height: checkpoint.height, hash: checkpoint.tipHash });
  let supply = 0;
  for (const [index, [address, amountUnits]] of expected.entries()) {
    const legacy = checkpoint.allocations[index];
    assert.equal(addressFromPublicKey(legacy.publicKey), address);
    assert.equal(legacy.amountUnits, amountUnits);
    assert.equal(allocations.get(address), amountUnits);
    assert.equal(chain.getBalanceUnits(address), amountUnits);
    assert.equal(otherNetwork.getBalanceUnits(address), 0);
    assert.equal(testnet.genesis.allocations.some(value => value.address === address), false);
    supply += amountUnits;
  }
  assert.equal(supply, 255400);
  assert.equal(chain.getIssuedUnits(), 255400);
  assert.equal(mainnet.genesis.allocations.reduce((sum, value) => sum + value.amountUnits, 0), 255400);
  const restored = new Blockchain(JSON.parse(JSON.stringify(mainnet))).loadState(JSON.stringify(chain.exportState()));
  assert.equal(restored.genesisHash, chain.genesisHash);
  assert.equal(restored.rulesHash, chain.rulesHash);
  assert.deepEqual(restored.chain[0].toJSON(), chain.chain[0].toJSON());
  assert.equal(restored.getIssuedUnits(), 255400);
  for (const [address, amountUnits] of expected) assert.equal(restored.getBalanceUnits(address), amountUnits);
  assert.notEqual(otherNetwork.genesisHash, chain.genesisHash);
});
