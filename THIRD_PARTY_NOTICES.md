# Third-Party Notices

StarBrowser includes or is built with third-party software. The StarBrowser
project license applies only to the project's original portions. Third-party
components remain under their own licenses and copyright notices.

## Main components

| Component | License | Role |
|---|---|---|
| Electron | MIT | Desktop runtime |
| Chromium and its components | BSD-style and other licenses listed by Chromium | Browser engine bundled by Electron |
| Vue 3 | MIT | User interface framework |
| Naive UI | MIT | User interface components |
| Ionicons / `@vicons/ionicons5` | MIT | Interface icons |
| perfect-scrollbar | MIT | Session-list scrollbar |
| yauzl | MIT | Secure ZIP reading |
| Vite | MIT | Build tool |
| TypeScript | Apache-2.0 | Build tool and type checking |
| Lightning CSS | MPL-2.0 | Build-time CSS processing dependency |

The packaged Windows application also contains:

- `LICENSE.electron.txt` for Electron.
- `LICENSES.chromium.html` containing Chromium and bundled component notices.
- License files inside relevant source packages installed through npm.

The MPL-2.0 dependency is used as build tooling. Its license continues to
apply to that component and does not replace the license of StarBrowser's
original files.

This notice is a convenience index and is not a substitute for the complete
license texts shipped with the corresponding components.
