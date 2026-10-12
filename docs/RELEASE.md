# Building and releasing FriendCoin

## Current release status

`2.0.0-rc.1` is a protocol 2 release candidate. The tracked mainnet snapshot prepares a migration; it does not activate the new network or alter the running legacy server. Tests and local builds use temporary directories and testnet. Publishing a client and migrating the existing network are separate operations.

The release workflow is ready to run when a matching version tag is pushed. This document does not claim that a version 2 release has already been published or that all platform builds have run successfully in GitHub Actions.

## Toolchain

CI and tagged releases use Node.js `24.16.0`. Source execution supports Node.js 22 or newer. Build dependencies are locked in `package-lock.json`: esbuild `0.28.2` and postject `1.0.0-alpha.6`.

The build bundles the client as CommonJS with [esbuild's build API](https://esbuild.github.io/api/#build), generates a preparation blob using `node --experimental-sea-config`, and injects it into a copy of that same Node.js executable with [postject](https://github.com/nodejs/postject). This follows the [official Node.js SEA procedure](https://nodejs.org/download/release/v24.16.0/docs/api/single-executable-applications.html). SEA remains an actively developed Node.js feature. Code caches and snapshots are disabled.

The bundle includes client source, statically imported public network JSON, and JavaScript `ws`. Optional `bufferutil` and `utf-8-validate` native addons are disabled. The build only follows imports; it does not scan wallet or data directories. A build input check rejects non-source files outside the allowed public network JSON and package metadata.

No wallet, password, private key, local chain, or user configuration is embedded. The executable reads its mutable settings and wallet files from its data directory at runtime. It must use SEA-aware path handling, rather than treating the embedded source as a directory on disk.

## Local build

```bash
npm ci
npm test
npm run test:release
npm run build
npm run build:smoke
```

`npm run build` creates only the current platform's artifact and its checksum in `dist/`. It copies the current `process.execPath`, so it does not cross-compile or download another runtime. Build each release target on that target OS and architecture.

The target names are `friendcoin-macos-arm64`, `friendcoin-macos-x64`, `friendcoin-linux-x64`, and `friendcoin-windows-x64.exe`. Other targets fail with an explicit error. Linux builds use the standard Node.js glibc runtime; Alpine/musl is not a supported target here.

The smoke script runs the executable's `--version` and `--help` with a temporary `--data-dir`, verifies the checksum, and checks that these informational commands create no wallet or state files. It also starts the empty testnet wallet menu and selects exit, verifying that only the chosen server setting is saved. These checks do not open real wallets or connect to a relay.

## Continuous integration

`.github/workflows/ci.yml` runs on branch pushes and pull requests. Four jobs run `npm ci`, the test suite, the release publisher fixture tests, the native build, and the binary smoke check. Another job tests the source with Node.js 22. Jobs use explicit [GitHub-hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners): `macos-15` for arm64, `macos-15-intel` for x64, `ubuntu-22.04`, and `windows-2022`.

Official GitHub actions are pinned to full commit SHAs. Before updating a pin, verify it against that action's official release and review its runtime requirements. Pull request CI has read-only repository permissions and cannot publish releases.

## Tagged GitHub release

1. Finish review, commit the complete candidate, and run CI on that commit.
2. Set the intended version in both `package.json` and the root metadata in `package-lock.json`.
3. Tag that commit as `v<package-version>`. The initial candidate tag is `v2.0.0-rc.1`.
4. Push the tag to trigger `.github/workflows/release.yml`.
5. Confirm that all four build jobs and the publication job passed. Download the artifacts and verify their checksums before distributing links.

The workflow rejects a tag that differs from the package version. All four targets run the test suite and binary smoke check before publication. The publication job verifies every downloaded artifact against its checksum, creates `SHA256SUMS`, uploads the files to a draft release, and then publishes it using the [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#create-a-release). A version containing a prerelease suffix, such as `-rc.1`, produces a GitHub prerelease.

Only the publication job receives `contents: write`, using GitHub's scoped workflow token. There is no SSH deployment, external upload key, or production restart. A failed upload leaves a draft rather than advertising an incomplete release. A retry may replace matching assets in that draft; the job refuses to overwrite an already published release. Use a new version tag for a correction after publication.

Checksums detect whether a file differs from the published copy. They do not replace a trusted release source or publisher identity.

## Signing and distribution limits

macOS builds remove the copied runtime signature before injection and apply an ad-hoc signature afterward, as required by the SEA procedure. They are not Apple Developer ID signed or notarized. Windows builds are not Authenticode signed. OS download warnings may therefore appear. Add signing and notarization before promising friction-free public installation.

Only the locally tested target can be reported as locally verified. GitHub's other matrix targets remain unverified until their actual jobs pass. CPU/OS compatibility, user installation, and a full wallet session require platform testing beyond `--help` and `--version`.

## Mainnet migration requirements

Before making protocol 2 the active mainnet:

1. Back up the running legacy server's chain and operational configuration. Preserve wallet ownership and balances during review of the migration candidate.
2. Verify the snapshot, supply, genesis data, network identifier, and agreed issuance rules against the source network. A candidate in Git is not proof that a live network has adopted it.
3. Exercise the new client and server together on testnet: wallet creation, explicit legacy import, transfers, mining, restart recovery, alternate relays, corrupted state recovery, and backup restoration.
4. Agree on a migration point and client upgrade window. Protocol 1 clients and the old server cannot be made compatible merely by changing the WebSocket URL.
5. Deploy the reviewed server with a dedicated data directory, logging, process supervision, and tested backups. Configure DNS and TLS before advertising a public `wss://` URL.
6. Publish the migration instructions and compatible client release, then verify the active network after cutover. Keep the legacy backup available for the agreed recovery process.

The currency still needs operating experience, independent security review, and an agreed economic policy before a production-ready claim is justified. A release artifact provides an installable client; it does not resolve those operational decisions by itself.
