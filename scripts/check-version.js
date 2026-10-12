const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function readJson(filename) {
  const contents = process.argv.includes("--staged")
    ? execFileSync("git", ["show", ":" + filename], { encoding: "utf8" })
    : fs.readFileSync(filename, "utf8");
  return JSON.parse(contents);
}

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const match = typeof pkg.version === "string" && pkg.version.match(pattern);
if (!match || (match[4] && match[4].split(".").some(value => /^\d+$/.test(value) && value.length > 1 && value.startsWith("0")))) {
  throw new Error("package.json must contain a valid semantic version");
}
if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
  throw new Error("package.json and package-lock.json must have the same version");
}
if (lock.packages[""].name !== pkg.name) throw new Error("Package and lockfile names differ");
console.log("Version metadata verified: " + pkg.version);
