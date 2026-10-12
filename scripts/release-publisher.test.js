const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const publish = require("./publish-release");
const { version } = require("../package.json");

const binaries = ["friendcoin-macos-arm64", "friendcoin-macos-x64", "friendcoin-linux-x64", "friendcoin-windows-x64.exe"];
const context = { repo: { owner: "fixture", repo: "fixture" } };
const core = { info() {} };

async function fixture(run) {
  const previousCwd = process.cwd();
  const previousTag = process.env.GITHUB_REF_NAME;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "friendcoin-release-test-"));
  fs.mkdirSync(path.join(directory, "release-artifacts"));
  for (const name of binaries) {
    const bytes = Buffer.from(`Synthetic executable: ${name}`);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(directory, "release-artifacts", name), bytes);
    fs.writeFileSync(path.join(directory, "release-artifacts", `${name}.sha256`), `${digest}  ${name}\n`);
  }
  process.chdir(directory);
  process.env.GITHUB_REF_NAME = `v${version}`;
  try { await run(directory); }
  finally {
    process.chdir(previousCwd);
    if (previousTag === undefined) delete process.env.GITHUB_REF_NAME;
    else process.env.GITHUB_REF_NAME = previousTag;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function githubFixture(releases = [], assets = []) {
  const writes = [];
  const repos = {
    listReleases: Symbol("releases"),
    listReleaseAssets: Symbol("assets"),
    async createRelease(params) { writes.push(["create", params]); return { data: { id: 1 } }; },
    async uploadReleaseAsset(params) { writes.push(["upload", params.name]); },
    async updateRelease(params) { writes.push(["publish", params]); },
    async deleteReleaseAsset(params) { writes.push(["delete", params.asset_id]); },
  };
  return { writes, rest: { repos }, async paginate(method) { return method === repos.listReleases ? releases : assets; } };
}

test("all four verified binaries are uploaded before the candidate is published", async () => fixture(async () => {
  const github = githubFixture();
  await publish({ github, context, core });
  const draft = github.writes.find(([kind]) => kind === "create")[1];
  assert.equal(draft.draft, true);
  assert.equal(draft.prerelease, version.includes("-"));
  const uploaded = github.writes.filter(([kind]) => kind === "upload").map(([, name]) => name);
  assert.equal(uploaded.length, 9);
  assert.ok(uploaded.includes("SHA256SUMS"));
  for (const name of binaries) assert.ok(uploaded.includes(name) && uploaded.includes(`${name}.sha256`));
  assert.equal(github.writes.at(-1)[0], "publish");
  assert.equal(github.writes.at(-1)[1].draft, false);
}));

test("a changed artifact is rejected before GitHub is contacted", async () => fixture(async directory => {
  fs.writeFileSync(path.join(directory, "release-artifacts", binaries[0]), "Modified executable");
  await assert.rejects(publish({ github: {}, context, core }), /Checksum mismatch/);
}));

test("an existing published release is never overwritten", async () => fixture(async () => {
  const github = githubFixture([{ id: 1, tag_name: `v${version}`, draft: false }]);
  await assert.rejects(publish({ github, context, core }), /published release already exists/);
  assert.deepEqual(github.writes, []);
}));

test("unexpected draft assets are rejected before any asset is deleted", async () => fixture(async () => {
  const github = githubFixture([{ id: 1, tag_name: `v${version}`, draft: true }], [
    { id: 1, name: binaries[0] }, { id: 2, name: "unexpected.txt" },
  ]);
  await assert.rejects(publish({ github, context, core }), /Unexpected asset/);
  assert.deepEqual(github.writes, []);
}));

test("an interrupted draft is recovered through listReleases and can be retried", async () => fixture(async () => {
  const github = githubFixture([{ id: 1, tag_name: `v${version}`, draft: true }], [{ id: 1, name: binaries[0] }]);
  await publish({ github, context, core });
  assert.equal(github.writes.filter(([kind]) => kind === "create").length, 0);
  assert.equal(github.writes.filter(([kind]) => kind === "delete").length, 1);
  assert.equal(github.writes.filter(([kind]) => kind === "upload").length, 9);
  assert.equal(github.writes.at(-1)[0], "publish");
}));
