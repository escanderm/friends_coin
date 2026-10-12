const path = require("path");
const { isSea } = require("node:sea");

function parseArguments(argv, valueFlags, booleanFlags = []) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith("--")) throw new Error("Неизвестный аргумент: " + argument);
    const equal = argument.indexOf("=");
    const name = argument.slice(2, equal < 0 ? undefined : equal);
    if (booleanFlags.includes(name)) {
      if (equal >= 0) throw new Error("--" + name + " не принимает значение");
      values[name] = true;
      continue;
    }
    if (!valueFlags.includes(name)) throw new Error("Неизвестный параметр: --" + name);
    const value = equal < 0 ? argv[++i] : argument.slice(equal + 1);
    if (!value || value.startsWith("--")) throw new Error("Укажите значение --" + name);
    if (name === "relay") {
      values.relay = [...(values.relay || []), value];
    } else {
      if (Object.hasOwn(values, name)) throw new Error("Укажите --" + name + " только один раз");
      values[name] = value;
    }
  }
  return values;
}

function resolveDataDirectory(input) {
  const base = isSea() || process.pkg ? path.dirname(process.execPath) : process.cwd();
  return path.resolve(input || process.env.FRIENDCOIN_DATA_DIR || path.join(base, "friendcoin-data"));
}

function portNumber(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("Порт должен быть целым числом");
  const number = Number(value);
  if (number < 1 || number > 65535) throw new Error("Порт должен быть от 1 до 65535");
  return number;
}

module.exports = { parseArguments, resolveDataDirectory, portNumber };
