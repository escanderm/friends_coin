const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");
const { inject } = require("postject");
const { artifactName, artifactPath } = require("./build-target");

const root = path.resolve(__dirname, "..");
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const clientSources = new Set(["terminal-ui.js", "nft.js", "nft-cli.js", "start.js", "user.js", "wallet.js", "blockchain.js", "protocol.js", "peer-protocol.js", "storage.js", "cli.js", "network-config.js", "server-config.js"]);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function assertPublicInputs(inputs) {
  for (const input of Object.keys(inputs)) {
    if (input.startsWith("disabled-native:")) continue;
    const relative = path.relative(root, path.resolve(root, input)).split(path.sep).join("/");
    if (relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error("Refusing to embed an input outside the project directory");
    }
    if (relative.startsWith("node_modules/") && !relative.endsWith(".node")) continue;
    if (clientSources.has(relative)) continue;
    if (relative === "package.json" || /^networks\/[a-zA-Z0-9_.-]+\.json$/.test(relative)) continue;
    throw new Error(`Refusing to embed a non-source input: ${relative}`);
  }
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("Building FriendCoin requires Node.js 22 or newer; CI uses Node.js 24.16.0.");
  }
  const name = artifactName();
  const output = artifactPath();
  const checksum = `${output}.sha256`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-build-"));
  try {
    const bundle = path.join(stage, "client.cjs");
    const result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: ["start.js"],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      metafile: true,
      sourcemap: false,
      minifySyntax: true,
      define: {
        "process.env.WS_NO_BUFFER_UTIL": '"1"',
        "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
      },
      plugins: [{
        name: "allow-public-source-inputs",
        setup(build) {
          build.onLoad({ filter: /.*/, namespace: "file" }, args => {
            assertPublicInputs({ [args.path]: {} });
            return null;
          });
        },
      }, {
        name: "disable-ws-native-addons",
        setup(build) {
          build.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, args => ({
            path: args.path,
            namespace: "disabled-native",
          }));
          build.onLoad({ filter: /.*/, namespace: "disabled-native" }, () => ({
            contents: 'throw new Error("Optional native ws addons are disabled in FriendCoin builds");',
            loader: "js",
          }));
        },
      }],
    });
    assertPublicInputs(result.metafile.inputs);
    if (result.warnings.length) throw new Error("Resolve bundler warnings before releasing a client.");

    const blob = path.join(stage, "sea-prep.blob");
    const config = path.join(stage, "sea-config.json");
    fs.writeFileSync(config, JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      execArgvExtension: "none",
    }));
    run(process.execPath, ["--experimental-sea-config", config]);
    fs.copyFileSync(process.execPath, output);
    if (process.platform === "darwin") run("codesign", ["--remove-signature", output]);
    await inject(output, "NODE_SEA_BLOB", fs.readFileSync(blob), {
      sentinelFuse: fuse,
      ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
    });
    if (process.platform === "darwin") run("codesign", ["--sign", "-", output]);
    if (process.platform !== "win32") fs.chmodSync(output, 0o755);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex");
    fs.writeFileSync(checksum, `${digest}  ${name}\n`);
    console.log(`Built dist/${name} and dist/${name}.sha256 with Node.js ${process.versions.node}`);
  } catch (error) {
    fs.rmSync(output, { force: true });
    fs.rmSync(checksum, { force: true });
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
});
