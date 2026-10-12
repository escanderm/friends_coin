const path = require("node:path");

function artifactName(platform = process.platform, arch = process.arch) {
  const names = {
    "darwin-arm64": "friendcoin-macos-arm64",
    "darwin-x64": "friendcoin-macos-x64",
    "linux-x64": "friendcoin-linux-x64",
    "win32-x64": "friendcoin-windows-x64.exe",
  };
  const name = names[`${platform}-${arch}`];
  if (!name) throw new Error(`Unsupported build target: ${platform}-${arch}`);
  return name;
}

function artifactPath() {
  return path.join(__dirname, "..", "dist", artifactName());
}

module.exports = { artifactName, artifactPath };
