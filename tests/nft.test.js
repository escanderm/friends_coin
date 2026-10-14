"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Wallet } = require("../wallet");
const { Blockchain, Transaction } = require("../blockchain");
const { tokenId, splitSale } = require("../nft");
const { blockHash, hashMeetsTarget } = require("../protocol");
const [A, B, C, M] = ["Author", "Buyer", "NextBuyer", "Miner"].map(name => new Wallet(name).generate());
function network(extra = {}) {
  return { ...require("../networks/testnet.json"), networkId: "nft-test", nftActivationHeight: 2,
    initialTarget: "f".repeat(64), maxTarget: "f".repeat(64),
    genesis: { timestamp: Date.now() - 60000, allocations: [A, B, C].map(w => ({ address: w.address, amountUnits: 50000 })) }, ...extra };
}
const metadata = { name: "Mathew #1", description: "Test", imageUri: "", imageSha256: "a".repeat(64) };
function action(chain, wallet, type, extra = {}) {
  const nonce = chain.getNextNonce(wallet.address);
  return wallet.signTransaction(new Transaction({ type, networkId: chain.network.networkId, from: wallet.address, to: wallet.address,
    amountUnits: 0, feeUnits: 1, nonce, tokenId: tokenId(chain.network.networkId, A.address, 1),
    revision: type === "nft_mint" ? 0 : chain.getNft(tokenId(chain.network.networkId, A.address, 1), { pending: true })?.revision,
    metadata: type === "nft_mint" ? metadata : null, ...extra }));
}
async function submit(chain, wallet, type, extra) { const tx = chain.addTransaction(action(chain, wallet, type, extra)); await chain.mineBlock(M.address); return tx; }
async function minted() {
  const chain = new Blockchain(network()); await chain.mineBlock(M.address);
  await submit(chain, A, "nft_mint"); return chain;
}
const id = chain => tokenId(chain.network.networkId, A.address, 1);
const code = value => e => e.code === value;
test("activation preserves genesis and all earlier blocks, then changes rules", async () => {
  const config = network(), { nftActivationHeight, ...legacy } = config;
  const old = new Blockchain(legacy), next = new Blockchain(config);
  assert.equal(next.genesisHash, old.genesisHash);
  assert.throws(() => next.addTransaction(action(next, A, "nft_mint")), code("NFT_NOT_ACTIVE"));
  const historical = await old.mineBlock(M.address); next.receiveBlock(historical);
  assert.equal(next.getBalanceUnits(A.address), old.getBalanceUnits(A.address));
  const tx = action(next, A, "nft_mint");
  assert.throws(() => old.addTransaction(tx), code("NFT_DISABLED"));
  next.addTransaction(tx); const block = await next.mineBlock(M.address);
  assert.equal(block.rulesHash, next.upgradeHash);
  assert.throws(() => old.receiveBlock(block), code("BAD_RULES"));
  const restored = new Blockchain(config).loadState(next.exportState());
  assert.deepEqual(restored.getNft(id(next)), next.getNft(id(next)));
});
test("100 FC purchase charges buyer exactly 100, pays 94/5/1 and later royalties", async () => {
  const chain = await minted();
  await submit(chain, A, "nft_offer", { amountUnits: 10000 });
  const a = chain.getBalanceUnits(A.address), b = chain.getBalanceUnits(B.address), m = chain.getBalanceUnits(M.address);
  await submit(chain, B, "nft_buy", { to: A.address, amountUnits: 10000, feeUnits: 500 });
  assert.equal(chain.getBalanceUnits(A.address) - a, 9500);
  assert.equal(b - chain.getBalanceUnits(B.address), 10000);
  assert.equal(chain.getBalanceUnits(M.address) - m, 600); // 5 FC fee + ordinary 1 FC block reward
  assert.equal(chain.getNft(id(chain)).owner, B.address);
  await submit(chain, B, "nft_offer", { amountUnits: 20000 });
  const before = [A, B, C, M].map(w => chain.getBalanceUnits(w.address));
  await submit(chain, C, "nft_buy", { to: B.address, amountUnits: 20000, feeUnits: 1000 });
  assert.deepEqual([A, B, C, M].map((w, i) => chain.getBalanceUnits(w.address) - before[i]), [200, 18800, -20000, 1100]);
  assert.equal(chain.getIssuedUnits(), 150000 + chain.getLastBlock().height * 100);
  const replay = new Blockchain(chain.network).loadState(chain.exportState());
  assert.equal(replay.getNft(id(chain)).owner, C.address);
  assert.deepEqual(replay.exportState(), chain.exportState());
});
test("author can buy back: account aliasing preserves balances and nonce", async () => {
  const chain = await minted();
  await submit(chain, A, "nft_transfer", { to: B.address });
  await submit(chain, B, "nft_offer", { amountUnits: 10000 });
  const a = chain.getBalanceUnits(A.address), b = chain.getBalanceUnits(B.address), nonce = chain.getNextNonce(A.address);
  await submit(chain, A, "nft_buy", { to: B.address, amountUnits: 10000, feeUnits: 500 });
  assert.equal(chain.getBalanceUnits(A.address), a - 9900);
  assert.equal(chain.getBalanceUnits(B.address), b + 9400);
  assert.equal(chain.getConfirmedNonce(A.address), nonce);
});
test("wrong signatures, prices, owners, duplicate buys, cancelled and stale offers are rejected", async () => {
  const chain = await minted();
  assert.throws(() => chain.addTransaction(action(chain, B, "nft_transfer", { to: C.address })), code("NFT_NOT_OWNER"));
  await submit(chain, A, "nft_offer", { amountUnits: 10000 });
  const buy = action(chain, B, "nft_buy", { to: A.address, amountUnits: 10000, feeUnits: 500 });
  assert.throws(() => chain.addTransaction({ ...buy.toJSON(), amountUnits: 20000, feeUnits: 1000 }), code("BAD_SIGNATURE"));
  assert.throws(() => action(chain, B, "nft_buy", { to: A.address, amountUnits: 10000, feeUnits: 1 }), code("BAD_NFT_FEE"));
  assert.throws(() => chain.addTransaction(action(chain, B, "nft_buy", { to: A.address, amountUnits: 20000, feeUnits: 1000 })), code("NFT_NOT_FOR_SALE"));
  await submit(chain, A, "nft_cancel");
  assert.throws(() => chain.addTransaction(buy), code("NFT_STALE"));
  await submit(chain, A, "nft_offer", { amountUnits: 10000 });
  assert.throws(() => chain.addTransaction(buy), code("NFT_STALE"));
  const first = action(chain, B, "nft_buy", { to: A.address, amountUnits: 10000, feeUnits: 500 });
  const second = action(chain, C, "nft_buy", { to: A.address, amountUnits: 10000, feeUnits: 500 });
  chain.addTransaction(first);
  assert.throws(() => chain.addTransaction(second), code("NFT_STALE"));
  assert.equal(chain.getNft(id(chain)).owner, A.address);
  assert.equal(chain.getNft(id(chain), { pending: true }).owner, B.address);
});
test("reorg restores NFT ownership and reserves a detached purchase in the pool", async () => {
  const chain = await minted(); await submit(chain, A, "nft_offer", { amountUnits: 10000 });
  const fork = new Blockchain(chain.network).loadState(chain.exportState());
  await submit(chain, B, "nft_buy", { to: A.address, amountUnits: 10000, feeUnits: 500 });
  await fork.mineBlock(C.address); await fork.mineBlock(C.address);
  for (const block of fork.chain.slice(-2)) chain.receiveBlock(block);
  assert.equal(chain.getNft(id(chain)).owner, A.address);
  assert.equal(chain.pendingTransactions.length, 1);
  await chain.mineBlock(M.address);
  assert.equal(chain.getNft(id(chain)).owner, B.address);
});
test("forged ownership and coinbase cannot pass proof-of-work replay", async () => {
  const chain = await minted(), block = chain.getLastBlock().toJSON();
  const parent = new Blockchain(chain.network); parent.receiveBlock(chain.chain[1]);
  block.transactions[1].metadata = { ...block.transactions[1].metadata, name: "Changed" };
  do { block.nonce++; block.hash = blockHash(block); } while (!hashMeetsTarget(block.hash, block.target));
  assert.throws(() => parent.receiveBlock(block), code("BAD_SIGNATURE"));
  const invalid = chain.getLastBlock().toJSON(); invalid.transactions[0].amountUnits++;
  do { invalid.nonce++; invalid.hash = blockHash(invalid); } while (!hashMeetsTarget(invalid.hash, invalid.target));
  assert.throws(() => parent.receiveBlock(invalid), code("BAD_COINBASE"));
});
test("fractional FC rounding never creates coins and metadata is immutable", async () => {
  for (const price of [100, 101, 299, 10000, 100000000]) {
    const split = splitSale(price);
    assert.equal(split.minerUnits + split.authorUnits + split.sellerUnits, price);
  }
  assert.deepEqual(splitSale(299), { minerUnits: 14, authorUnits: 2, sellerUnits: 283 });
  assert.throws(() => splitSale(99), code("BAD_NFT_PRICE"));
  const chain = await minted();
  assert.throws(() => { chain.getNft(id(chain)).metadata.name = "mutated"; }, TypeError);
  assert.throws(() => { chain.getNft(id(chain)).owner = B.address; }, TypeError);
});
