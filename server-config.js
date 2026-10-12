const fs = require("fs");
const path = require("path");

const CONFIG_FILE = "friendcoin.config.json";

function validateServerUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Укажите адрес сервера: ws://адрес:8088 или wss://домен");
  }

  const input = value.trim();
  let url;
  try {
    url = new URL(input);
  } catch (e) {
    throw new Error("Неверный адрес сервера: используйте ws://адрес:8088 или wss://домен");
  }

  if (
    !/^wss?:\/\//i.test(input) ||
    !["ws:", "wss:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    input.includes("#") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(input) ||
    /\s/.test(input)
  ) {
    throw new Error("Адрес должен начинаться с ws:// или wss://, без пробелов, пароля и #");
  }

  return url.href;
}

function resolveServerConfig({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  let argumentUrl;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--server" || argv[i].startsWith("--server=")) {
      if (argumentUrl !== undefined) {
        throw new Error("Укажите --server только один раз");
      }
      argumentUrl = argv[i] === "--server" ? argv[++i] : argv[i].slice(9);
      argumentUrl = validateServerUrl(argumentUrl);
    }
  }

  if (argumentUrl !== undefined) {
    return { serverUrl: argumentUrl, source: "argument" };
  }
  if (env.FRIENDCOIN_SERVER_URL !== undefined) {
    return {
      serverUrl: validateServerUrl(env.FRIENDCOIN_SERVER_URL),
      source: "environment",
    };
  }

  const configPath = path.join(cwd, CONFIG_FILE);
  let contents;
  try {
    contents = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { serverUrl: null, source: null };
    throw new Error(`Не удалось прочитать ${CONFIG_FILE}: ${e.message}`);
  }

  let config;
  try {
    config = JSON.parse(contents);
  } catch (e) {
    throw new Error(`Повреждён ${CONFIG_FILE}. Исправьте файл или укажите --server URL`);
  }
  return {
    serverUrl: validateServerUrl(config && config.serverUrl),
    source: "file",
  };
}

function saveServerUrl(serverUrl, cwd = process.cwd()) {
  const configPath = path.join(cwd, CONFIG_FILE);
  fs.writeFileSync(
    configPath,
    JSON.stringify({ serverUrl: validateServerUrl(serverUrl) }, null, 2) + "\n",
  );
}

module.exports = { CONFIG_FILE, validateServerUrl, resolveServerConfig, saveServerUrl };
