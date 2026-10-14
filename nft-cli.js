"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { sha256, formatAmountUnits: money, parseAmountUnits } = require("./protocol");
const { splitSale } = require("./nft");
const { atomicWrite } = require("./storage");
function filePath(value) {
  let input = value.trim();
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) input = input.slice(1, -1);
  if (input.startsWith("~/")) input = path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}
function prepareImage(filename, dataDir) {
  const source = filePath(filename), fd = fs.openSync(source, "r");
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 10 * 1024 * 1024) throw new Error("Нужен файл изображения размером до 10 МБ");
    bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) { const count = fs.readSync(fd, bytes, read, bytes.length - read, read); if (!count) throw new Error("Файл изменился при чтении"); read += count; }
  } finally { fs.closeSync(fd); }
  let extension;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) extension = ".jpg";
  else if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = ".png";
  else if (bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP") extension = ".webp";
  else throw new Error("Поддерживаются JPEG, PNG и WebP");
  const imageSha256 = sha256(bytes), destination = path.join(dataDir, "nft-media", imageSha256 + extension);
  atomicWrite(destination, bytes);
  return { imageSha256, destination };
}
function details(token) {
  return token.metadata.name + "\nID: " + token.id + "\nВладелец: " + token.owner + "\nАвтор: " + token.creator +
    "\nSHA-256 изображения: " + token.metadata.imageSha256 + "\nИзображение: " + (token.metadata.imageUri || "ссылка не опубликована; файл передаётся отдельно") +
    "\nЦена: " + (token.offer ? money(token.offer.priceUnits) + " FC" : "не продаётся");
}
async function confirm(terminal, text) {
  console.log(text);
  return await terminal.menu("Подтвердить операцию?", ["Отмена", "Подтвердить"]) === 1;
}
async function runNftMenu(terminal, user) {
  const chain = user.blockchain;
  if (chain.network.nftActivationHeight === undefined) throw new Error("NFT ещё не включены в этой сети. Нужна согласованная активация клиента и сервера.");
  if (chain.getLastBlock().height + 1 < chain.network.nftActivationHeight) throw new Error("NFT будут доступны с блока #" + chain.network.nftActivationHeight);
  const selection = await terminal.menu("NFT · продажа: 94% продавцу, 5% майнеру, 1% автору", ["Мои NFT", "Купить NFT", "Выпустить NFT из изображения", "Назад"]);
  if (selection === null || selection === 3) return;
  let result;
  const fee = money(user.network.minFeeUnits);
  if (selection === 2) {
    const filename = await terminal.question("Путь к изображению (можно ../../): ");
    const name = (await terminal.question("Название NFT: ")).trim();
    const description = (await terminal.question("Описание (Enter — пропустить): ")).trim();
    const imageUri = (await terminal.question("Ссылка HTTPS/IPFS (Enter — файл будет храниться только локально): ")).trim();
    const image = prepareImage(filename, user.dataDir);
    if (!await confirm(terminal, "Выпуск: " + name + "\nКопия изображения: " + image.destination + "\nАвтор и первый владелец: " + user.wallet.address + "\nКомиссия майнеру: " + fee + " FC\nОписание, хеш и указанная ссылка будут записаны в общую цепочку.")) return;
    result = user.sendNft("nft_mint", { metadata: { name, description, imageUri, imageSha256: image.imageSha256 } });
  } else {
    const tokens = chain.getNfts().filter(token => selection === 0 ? token.owner === user.wallet.address : token.offer && token.owner !== user.wallet.address);
    if (!tokens.length) { console.log(selection === 0 ? "У этого кошелька пока нет подтверждённых NFT." : "В цепочке нет доступных предложений продажи."); return; }
    const choice = await terminal.menu(selection === 0 ? "Мои NFT" : "Предложения продажи", [...tokens.map(token => token.metadata.name + (token.offer ? " · " + money(token.offer.priceUnits) + " FC" : "")), "Назад"]);
    if (choice === null || choice === tokens.length) return;
    const token = tokens[choice]; console.log(details(token));
    const base = { tokenId: token.id, revision: token.revision };
    if (selection === 1) {
      const split = splitSale(token.offer.priceUnits);
      if (!await confirm(terminal, "Всего к оплате: " + money(token.offer.priceUnits) + " FC\nПродавцу: " + money(split.sellerUnits) + " FC; майнеру: " + money(split.minerUnits) + " FC; автору: " + money(split.authorUnits) + " FC\nДополнительной комиссии за покупку нет.")) return;
      result = user.sendNft("nft_buy", { ...base, to: token.owner, amountUnits: token.offer.priceUnits });
    } else {
      const action = await terminal.menu("Действие с NFT", ["Выставить / изменить цену", "Снять с продажи", "Передать в подарок", "Назад"]);
      if (action === null || action === 3) return;
      if (action === 0) {
        const amountUnits = parseAmountUnits((await terminal.question("Цена в FC (не меньше 1 FC): ")).trim());
        const split = splitSale(amountUnits);
        if (!await confirm(terminal, "Цена: " + money(amountUnits) + " FC\nПри продаже: продавцу " + money(split.sellerUnits) + ", майнеру " + money(split.minerUnits) + ", автору " + money(split.authorUnits) + " FC\nЗа запись предложения: " + fee + " FC майнеру.")) return;
        result = user.sendNft("nft_offer", { ...base, amountUnits });
      } else if (action === 1) {
        if (!await confirm(terminal, "Снять NFT с продажи. Комиссия майнеру: " + fee + " FC")) return;
        result = user.sendNft("nft_cancel", base);
      } else {
        const to = user.resolveRecipient((await terminal.question("Адрес или имя получателя: ")).trim());
        if (!await confirm(terminal, "Подарить NFT: " + to + "\nОплаты за NFT нет. Комиссия майнеру: " + fee + " FC")) return;
        result = user.sendNft("nft_transfer", { ...base, to });
      }
    }
  }
  console.log("Операция NFT в пуле: " + result.id + "\nID NFT: " + result.transaction.tokenId + "\nВладелец и баланс изменятся после включения в блок. Проверка: nft / history");
}
module.exports = { runNftMenu, prepareImage, details };
