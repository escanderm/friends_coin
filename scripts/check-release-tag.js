const { version } = require("../package.json");

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (!tag || tag !== `v${version}`) {
  console.error(`Release tag must be v${version}; received ${tag || "no tag"}`);
  process.exitCode = 1;
} else {
  console.log(`Release tag matches package version: ${tag}`);
}
