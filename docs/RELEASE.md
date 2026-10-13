# Building and releasing the FriendCoin client

The public repository contains the desktop client. Server implementation, Docker files, deployment procedures and server integration tests are maintained privately.

## Toolchain

CI uses Node.js `24.16.0`; source execution supports Node.js 22 or newer. esbuild `0.28.2` bundles the client, and postject `1.0.0-alpha.6` injects the preparation blob into a copy of that same runtime using the [Node.js SEA procedure](https://nodejs.org/download/release/v24.16.0/docs/api/single-executable-applications.html).

The build permits only the listed client modules, public network JSON, package metadata and JavaScript dependencies. It rejects server modules and private directories. Wallets, passwords, local settings and local state are runtime files outside the executable.

## Local checks

```bash
npm ci
npm test
npm run test:release
npm run build
npm run build:smoke
```

The smoke check verifies the checksum, version, help and exit from the wallet menu in an isolated directory. Menu tests cover arrow/Enter navigation, terminal restoration, hidden passwords, relative folders, remembered wallet selection and explicit legacy import.

The real interactive terminal uses arrows. Numeric input is retained only for redirected input used by automated checks, matching the original fallback behavior.

## Tagged release

1. Set the same semantic version in package.json and package-lock.json.
2. Run client tests and native builds in CI; run server integration checks in the private project.
3. Tag the reviewed client commit as `v<version>` and push the tag.
4. Verify all four build jobs and the publication job.
5. Download and check all binaries against their individual checksums and `SHA256SUMS`.

The targets are macOS arm64, macOS x64, Linux x64 and Windows x64. The publication job verifies all assets before publishing the draft. A prerelease suffix produces a GitHub prerelease. Published releases are not overwritten; corrections use a new version.

Public workflows have no server-repository credentials, private source checkout or production deployment. A client release does not upgrade the running server.

macOS uses an ad-hoc signature; Apple notarization and Windows Authenticode signing are not configured. A downloaded executable may require OS approval.

## Protocol 2 status

This remains a migration candidate. Existing balances are prepared as a checkpoint; live activation requires agreement with the operator and holders. The client and server must use the same network identifier, genesis and rules. See MIGRATION.md.
