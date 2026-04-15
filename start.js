const { User } = require("./user");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// Если запущен как бинарник (pkg) — работаем из папки где лежит бинарник
if (process.pkg) {
  process.chdir(path.dirname(process.execPath));
}

let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function selectMenu(title, items) {
  return new Promise((resolve) => {
    let selected = 0;
    const render = () => {
      process.stdout.write("\x1B[?25l"); // скрыть курсор
      process.stdout.write(`\x1B[${items.length + 1}A`); // вверх
      console.log(title);
      items.forEach((item, i) => {
        const prefix = i === selected ? " ▸ " : "   ";
        const style = i === selected ? "\x1B[36m\x1B[1m" : "\x1B[0m";
        console.log(`${style}${prefix}${item}\x1B[0m`);
      });
    };

    // Первый вывод
    console.log(title);
    items.forEach((item, i) => {
      const prefix = i === selected ? " ▸ " : "   ";
      const style = i === selected ? "\x1B[36m\x1B[1m" : "\x1B[0m";
      console.log(`${style}${prefix}${item}\x1B[0m`);
    });

    if (!process.stdin.setRawMode) {
      // Не интерактивный терминал — используем простой ввод
      process.stdout.write("\nВведите номер (1-" + items.length + "): ");
      process.stdin.resume();
      process.stdin.once("data", (data) => {
        const num = parseInt(data.toString().trim()) - 1;
        resolve(num >= 0 && num < items.length ? num : 0);
      });
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (key) => {
      if (key[0] === 27 && key[1] === 91) {
        if (key[2] === 65) selected = Math.max(0, selected - 1); // вверх
        if (key[2] === 66) selected = Math.min(items.length - 1, selected + 1); // вниз
        render();
      } else if (key[0] === 13) {
        // Enter
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onKey);
        process.stdout.write("\x1B[?25h"); // показать курсор
        // Пересоздаём readline после raw mode
        rl.close();
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        resolve(selected);
      } else if (key[0] === 3) {
        // Ctrl+C
        process.stdout.write("\x1B[?25h");
        process.exit(0);
      }
    };
    process.stdin.on("data", onKey);
  });
}

function validateWallet(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data.name || !data.address || !data.keys || !data.keys.privateKey) {
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

async function loadFromPath() {
  const input = await question("Путь к папке или файлу кошелька: ");
  const trimmed = input.trim();

  if (!fs.existsSync(trimmed)) {
    console.log(`❌ Не найдено: ${trimmed}`);
    return null;
  }

  const stat = fs.statSync(trimmed);

  if (stat.isFile()) {
    // Указали файл напрямую
    const wallet = validateWallet(trimmed);
    if (!wallet) {
      console.log("❌ Файл повреждён или не является кошельком");
      return null;
    }
    console.log(`✅ Кошелёк ${wallet.name} загружен`);
    return trimmed;
  }

  if (stat.isDirectory()) {
    // Указали папку — ищем кошельки
    const wallets = fs
      .readdirSync(trimmed)
      .filter((f) => f.startsWith("wallet_") && f.endsWith(".json"));

    if (wallets.length === 0) {
      console.log("❌ Кошельки не найдены в этой папке");
      return null;
    }

    const names = wallets.map((f) =>
      f.replace("wallet_", "").replace(".json", ""),
    );
    const idx = await selectMenu(`\n📂 Кошельки в ${trimmed}:`, names);
    const filePath = path.join(trimmed, wallets[idx]);
    const wallet = validateWallet(filePath);
    if (!wallet) {
      console.log("❌ Файл повреждён или не является кошельком");
      return null;
    }
    console.log(`\n✅ Кошелёк ${wallet.name} загружен`);
    return filePath;
  }

  return null;
}

async function main() {
  console.log("\n=== Добро пожаловать в FriendCoin ===\n");

  const files = fs.readdirSync(".");
  const existingWallets = files
    .filter((f) => f.startsWith("wallet_") && f.endsWith(".json"))
    .map((f) => f.replace("wallet_", "").replace(".json", ""));

  let userName = null;
  let walletPath = null;
  let isNewUser = false;

  const menuItems = [
    ...existingWallets,
    "Создать нового пользователя",
    "Загрузить кошелёк с флешки/диска",
    "Выйти",
  ];

  const idx = await selectMenu("📂 Выберите кошелёк:", menuItems);

  if (idx === menuItems.length - 1) {
    // Выйти
    console.log("\nДо свидания!");
    rl.close();
    return;
  } else if (idx === menuItems.length - 2) {
    // Загрузить с флешки
    walletPath = await loadFromPath();
    if (!walletPath) {
      rl.close();
      return;
    }
    userName = "loading";
  } else if (idx === menuItems.length - 3) {
    // Создать нового
    isNewUser = true;
  } else {
    // Существующий кошелёк
    userName = existingWallets[idx];
    console.log(`\n✅ Добро пожаловать обратно, ${userName}!`);
  }

  if (isNewUser) {
    console.log("\n✨ Создание нового кошелька");

    let validName = false;
    while (!validName) {
      const input = await question(
        "Введите ваше имя (только латиница, без пробелов): ",
      );

      if (!input || input.trim() === "") {
        console.log("❌ Имя не может быть пустым");
        continue;
      }

      if (!/^[a-zA-Z0-9_]+$/.test(input)) {
        console.log(
          "❌ Имя может содержать только латиницу, цифры и подчёркивание",
        );
        continue;
      }

      if (fs.existsSync(`wallet_${input}.json`)) {
        console.log(`❌ Пользователь "${input}" уже существует`);
        continue;
      }

      userName = input;
      validName = true;
    }

    console.log(`\n✅ Создаётся кошелёк для ${userName}...`);
  }

  rl.close();

  console.log("\n🚀 Запуск...\n");
  const user = new User(userName, undefined, walletPath);
  user.init();

  setTimeout(() => {
    user.startCLI();
  }, 2000);
}

main().catch(console.error);
