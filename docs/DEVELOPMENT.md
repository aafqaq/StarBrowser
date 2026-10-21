# Development / 开发指南

## Environment

- Windows 10 / 11 x64 for the supported application and packaging tests.
- Node.js 22 and npm, matching the Windows CI workflow.
- Git, and sufficient disk space for Electron and packaged builds.

## Setup

```powershell
git clone https://github.com/aafqaq/StarBrowser.git
cd StarBrowser
npm ci
npm run dev
```

Use npm ci with the committed lockfile. Development starts Vite on localhost and launches Electron. Use test accounts and synthetic browser data during development; never commit the data directory, cookies, session archives or credentials.

## Checks

```powershell
npm run typecheck
npm run test:plugins
npm run test:update
npm run build
```

For changes to the updater or packaging, also run the Windows CI checks relevant to that path:

```powershell
npm run test:update:extract
npm run test:update:ui
npm run test:update:handoff
npm run dist
npm run test:smoke
npm run test:update:integration
```

The packaged tests require npm run dist first. npm run dist produces the portable folder under dist; it does not publish a release. See [.github/workflows/build.yml](../.github/workflows/build.yml) for the full CI sequence, including the security audit.

## Source map

| Path | Responsibility |
| --- | --- |
| main/electron.mjs | Electron lifecycle, browser sessions and IPC |
| main/plugin-service.mjs | Declarative plugin lifecycle and permissions |
| main/session-transfer-worker.mjs | Encrypted session archive processing |
| main/update-*.mjs | Update download, staging and filesystem handling |
| src/App.vue | Browser UI |
| plugins/README.md | Plugin manifest format |
| scripts/test-*.mjs | Regression and packaged smoke checks |

## Release checks

Use a clean checkout, run the Windows build workflow, review its results, and test the portable output with synthetic data before publishing. Include changes and known limitations in release notes. Preserve LICENSE-StarBrowser.txt, THIRD_PARTY_NOTICES.md and bundled component notices in distributions.
