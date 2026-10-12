const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { version } = require("../package.json");

// Invoked only by the tag workflow with GitHub's scoped GITHUB_TOKEN.
module.exports = async function publish({ github, context, core }) {
  const tag = process.env.GITHUB_REF_NAME;
  if (tag !== `v${version}`) throw new Error("Tag and package version do not match");
  const prerelease = version.includes("-");
  const directory = path.resolve("release-artifacts");
  const binaries = [
    "friendcoin-macos-arm64",
    "friendcoin-macos-x64",
    "friendcoin-linux-x64",
    "friendcoin-windows-x64.exe",
  ];
  const assets = binaries.flatMap(name => [name, `${name}.sha256`]);
  const sumLines = [];
  for (const name of binaries) {
    const bytes = fs.readFileSync(path.join(directory, name));
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const sum = `${digest}  ${name}`;
    if (fs.readFileSync(path.join(directory, `${name}.sha256`), "utf8").trim() !== sum) {
      throw new Error(`Checksum mismatch: ${name}`);
    }
    sumLines.push(sum);
  }
  const actualAssets = fs.readdirSync(directory).sort();
  if (JSON.stringify(actualAssets) !== JSON.stringify([...assets].sort())) {
    throw new Error("Release artifacts are incomplete or contain unexpected files");
  }
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), `${sumLines.join("\n")}\n`);
  assets.push("SHA256SUMS");

  const repo = context.repo;
  // The tag endpoint documents published releases only. List releases with the
  // write-scoped token to recover an interrupted draft on a workflow retry.
  const matches = (await github.paginate(github.rest.repos.listReleases, {
    ...repo,
    per_page: 100,
  })).filter(candidate => candidate.tag_name === tag);
  if (matches.length > 1) throw new Error("Multiple releases exist for this tag");
  let release = matches[0];
  if (release && !release.draft) {
    throw new Error("A published release already exists; use a new version tag");
  }
  if (!release) {
    release = (await github.rest.repos.createRelease({
      ...repo,
      tag_name: tag,
      name: `FriendCoin ${version}`,
      draft: true,
      prerelease,
      body: [
        `FriendCoin ${version}: protocol 2 client for macOS, Linux, and Windows.`,
        prerelease
          ? "This is a release candidate. The mainnet snapshot is a prepared migration candidate; it does not activate or migrate the legacy server."
          : "Review the migration and operating requirements before starting a mainnet server.",
        "Wallets and local settings are stored outside the executable. Verify downloads against SHA256SUMS.",
        "macOS binaries use an ad-hoc signature, not Apple notarization. Windows binaries are not Authenticode-signed.",
        "See README.md and docs/RELEASE.md in the tagged source for usage, migration, and limitations.",
      ].join("\n\n"),
    })).data;
  }
  const existing = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo,
    release_id: release.id,
    per_page: 100,
  });
  for (const asset of existing) {
    if (!assets.includes(asset.name)) throw new Error(`Unexpected asset in draft release: ${asset.name}`);
  }
  for (const asset of existing) {
    await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
  }
  for (const name of assets) {
    const bytes = fs.readFileSync(path.join(directory, name));
    await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: release.id,
      name,
      data: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
      },
    });
  }
  await github.rest.repos.updateRelease({ ...repo, release_id: release.id, draft: false, prerelease });
  core.info(`Published ${tag} with ${assets.length} verified assets`);
};
