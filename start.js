const { User } = require("./user");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// Если запущен как бинарник — работаем из папки где лежит бинарник
process.chdir(path.dirname(process.execPath));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
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

  if (existingWallets.length > 0) {
    console.log("📂 Найдены существующие кошельки:");
    existingWallets.forEach((name, idx) => {
      console.log(`   ${idx + 1}. ${name}`);
    });
    const nextNum = existingWallets.length + 1;
    console.log(`   ${nextNum}. Создать нового пользователя`);
    console.log(`   ${nextNum + 1}. Загрузить кошелёк с флешки/диска`);
    console.log(`   0. Выйти`);

    const choice = await question("\nВыберите номер: ");
    const num = parseInt(choice);

    if (num === 0) {
      console.log("До свидания!");
      rl.close();
      return;
    }

    if (num === nextNum) {
      isNewUser = true;
    } else if (num === nextNum + 1) {
      walletPath = await question("Путь к файлу кошелька (wallet_*.json): ");
      walletPath = walletPath.trim();
      if (!fs.existsSync(walletPath)) {
        console.log(`❌ Файл не найден: ${walletPath}`);
        rl.close();
        return;
      }
      // Имя возьмётся из файла кошелька при загрузке
      userName = "loading";
    } else if (num >= 1 && num <= existingWallets.length) {
      userName = existingWallets[num - 1];
      console.log(`\n✅ Добро пожаловать обратно, ${userName}!`);
    } else {
      console.log("❌ Неверный выбор");
      rl.close();
      return;
    }
  } else {
    console.log("📂 Кошельки не найдены");
    console.log("   1. Создать нового пользователя");
    console.log("   2. Загрузить кошелёк с флешки/диска");
    console.log("   0. Выйти");

    const choice = await question("\nВыберите номер: ");
    const num = parseInt(choice);

    if (num === 0) {
      console.log("До свидания!");
      rl.close();
      return;
    }

    if (num === 2) {
      walletPath = await question("Путь к файлу кошелька (wallet_*.json): ");
      walletPath = walletPath.trim();
      if (!fs.existsSync(walletPath)) {
        console.log(`❌ Файл не найден: ${walletPath}`);
        rl.close();
        return;
      }
      userName = "loading";
    } else {
      isNewUser = true;
    }
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
