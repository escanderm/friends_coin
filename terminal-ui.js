"use strict";
const { formatAmountUnits } = require("./protocol");
const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
function theme({ output = process.stdout, env = process.env, columns = output.columns || 80 } = {}) {
  const enabled = Boolean(output.isTTY) && env.NO_COLOR === undefined && env.TERM !== "dumb";
  const paint = (code, text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return { width: Math.max(20, Math.min(92, columns)), accent: text => paint("36", text), green: text => paint("32", text), muted: text => paint("90", text), bold: text => paint("1", text), warn: text => paint("33", text) };
}
function wrap(text, width) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    let remaining = clean(line);
    while (Array.from(remaining).length > width) {
      const chars = Array.from(remaining); let split = chars.slice(0, width + 1).lastIndexOf(" ");
      if (split < width / 3) split = width;
      rows.push(chars.slice(0, split).join("")); remaining = chars.slice(split).join("").trimStart();
    }
    rows.push(remaining);
  }
  return rows;
}
const groups = [
  ["КОШЕЛЁК", [["balance", "Баланс и доступно"], ["address", "Адрес кошелька"], ["send", "Отправить FC"], ["history", "История операций"]]],
  ["NFT", [["nft", "Коллекция и сделки"]]],
  ["МАЙНИНГ", [["mine", "Начать поиск блока"], ["stop", "Остановить майнинг"]]],
  ["СЕТЬ", [["friends", "Участники сети"], ["info", "Состояние узла"], ["rules", "Правила и сложность"], ["syncpool", "Обновить пул операций"]]],
  ["УПРАВЛЕНИЕ", [["help", "Показать это меню"], ["exit", "Сохранить данные и выйти"]]],
];
function renderHelp(version, options = {}) {
  const t = theme(options), inner = t.width - 4;
  const line = (text = "", paint = value => value) => wrap(text, inner).map(row => "  " + paint(row)).join("\n");
  const rows = ["", t.accent("  ┌" + "─".repeat(t.width - 4) + "┐"), line("FRIENDCOIN  /  " + version, t.bold), line("Твой кошелёк · твоя сеть", t.muted), t.accent("  └" + "─".repeat(t.width - 4) + "┘")];
  if (t.width >= 76) {
    const cellWidth = Math.floor((inner - 3) / 2);
    const cells = selected => selected.flatMap(([title, commands]) => [
      { text: "", kind: "plain" }, { text: title, kind: "heading" },
      ...commands.flatMap(([command, description]) => wrap(command.padEnd(10) + description, cellWidth).map((text, index) => ({ text, kind: index === 0 ? "command" : "plain" }))),
    ]);
    const left = cells(groups.slice(0, 3)), right = cells(groups.slice(3));
    const cell = value => {
      const { text = "", kind } = value || {};
      const padded = text.padEnd(cellWidth);
      if (kind === "heading") return t.accent(padded);
      if (kind === "command") return t.bold(padded.slice(0, 10)) + padded.slice(10);
      return t.muted(padded);
    };
    for (let i = 0; i < Math.max(left.length, right.length); i++) rows.push("  " + cell(left[i]) + "   " + cell(right[i]));
  } else {
    for (const [title, commands] of groups) {
      rows.push("", line(title, t.accent));
      for (const [command, description] of commands) {
        rows.push(line(command, t.bold), ...wrap(description, inner - 2).map(row => "    " + row));
      }
    }
  }
  rows.push("", line("Перевод: send <адрес или имя> <сумма> [комиссия]", t.muted), line("В меню кошельков и NFT: ↑ / ↓ · Enter · Esc", t.muted));
  if (options.launchOptions) {
    rows.push("", line("ПАРАМЕТРЫ ЗАПУСКА", t.accent));
    for (const text of ["--server ws://host:8088 | wss://domain", "--relay URL  — дополнительный сервер", "--data-dir PATH  — постоянная папка истории", "--network mainnet|testnet|nft-testnet", "--wallet PATH  — файл кошелька", "--restore-backup  — восстановить резервную копию", "--version  — версия", "--help  — справка"]) rows.push(line(text));
  }
  rows.push(""); return rows.join("\n");
}
function renderBalance(user, options = {}) {
  const t = theme(options), chain = user.blockchain;
  const height = chain.getLastBlock().height;
  const total = formatAmountUnits(chain.getBalanceUnits(user.wallet.address));
  const available = formatAmountUnits(chain.getAvailableBalanceUnits(user.wallet.address));
  const ready = user.ready;
  const line = (text, paint = value => value) => wrap(text, t.width - 4).map(row => "  " + paint(row)).join("\n");
  const rows = [ready ? line("● Синхронизировано", t.green) : line("◌ Локальные данные · ожидаем синхронизацию", t.warn),
    line("Баланс: " + total + " FC", t.bold), line("Доступно: " + available + " FC  ·  блок #" + height)];
  if (!ready) rows.push(line("После связи с сетью сумма может обновиться.", t.muted));
  return "\n" + rows.join("\n") + "\n";
}
module.exports = { renderHelp, renderBalance, theme, wrap };
