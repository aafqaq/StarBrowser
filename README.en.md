# StarBrowser

[English](README.en.md) · [简体中文](README.md)

StarBrowser is a portable Windows browser for keeping website sessions separate. Each session has its own persistent Chromium partition for cookies, local storage, IndexedDB, cache and login state. Tabs inside one session share that session's website data.

## Features

- Multiple isolated browser sessions in one window.
- Persistent tabs, per-session notes and shared bookmarks.
- Encrypted session backup and migration.
- Portable application and local data directory.
- Five performance modes and a declarative plugin system.
- Updates with SHA-256 verification and rollback handling.

## Download and run

1. Download the full Windows x64 ZIP from [Releases](https://github.com/aafqaq/StarBrowser/releases).
2. Extract the complete archive into a normal folder.
3. Run StarBrowser.exe, create a session and visit a website.

Windows 10 / 11 x64 is currently supported. The Chromium runtime is included. Do not run the application inside the ZIP or move individual files out of its folder.

## Local data and migration

Application data is stored in the data folder beside the executable. Exit the application before copying that folder for backup. Session archives can contain active login credentials; keep them private and use them for your own backup and migration. Passwords cannot be recovered.

The project does not provide cloud synchronization or upload browsing history, cookies, notes or bookmarks to a project server. Websites and installed plugins make their own network requests. Update checks and plugin catalog requests contact GitHub.

## Development and support

See the [development guide](docs/DEVELOPMENT.md) for reproducible setup and checks, [CONTRIBUTING](CONTRIBUTING.md) for issue and pull request guidance, and [SECURITY](SECURITY.md) for security reports. Screenshots and detailed feature explanations are in the [Chinese README](README.md).

## License

The project's original code, documentation and original assets are available under the [MIT License](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).
