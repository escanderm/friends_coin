"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareImage, runNftMenu } = require("../nft-cli");
const { sha256 } = require("../protocol");
test("image import preserves original bytes and resolves relative paths", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fc-nft-image-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = Buffer.from([255,216,255,224,1,2,3,255,217]);
  const source = path.join(directory, "with spaces.jpg"); fs.writeFileSync(source, original);
  const image = prepareImage('"' + path.relative(process.cwd(), source) + '"', path.join(directory, "data"));
  assert.equal(image.imageSha256, sha256(original));
  assert.deepEqual(fs.readFileSync(source), original); assert.deepEqual(fs.readFileSync(image.destination), original);
  assert.throws(() => prepareImage(directory, directory), /файл изображения/);
});
test("NFT menu uses shared menu controls and cancel never signs a purchase", async () => {
  const token = { id: "a".repeat(64), owner: "seller", creator: "author", revision: 7, offer: { priceUnits: 10000 }, metadata: { name: "Photo", imageSha256: "b".repeat(64), imageUri: "" } };
  const menus = [], selections = [1, 0, 0]; let signed = false;
  const terminal = { async menu(title, items) { menus.push({ title, items }); return selections.shift(); } };
  const user = { wallet: { address: "buyer" }, network: { minFeeUnits: 1 }, blockchain: { network: { nftActivationHeight: 1 }, getLastBlock: () => ({ height: 5 }), getNfts: () => [token] }, sendNft() { signed = true; } };
  await runNftMenu(terminal, user);
  assert.equal(signed, false); assert.equal(menus.length, 3); assert.deepEqual(menus[2].items, ["Отмена", "Подтвердить"]);
});
