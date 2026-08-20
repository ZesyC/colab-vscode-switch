# Google Colab VS Code Extension

Colab is a hosted Jupyter Notebook service that requires no setup to use and
provides free access to computing resources, including GPUs and TPUs. Built atop
the [Jupyter
extension](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter),
this extension exposes Colab servers directly in VS Code!

- 👾 [Bug
  report](https://github.com/googlecolab/colab-vscode/issues/new?template=bug_report.md)
- ✨ [Feature
  request](https://github.com/googlecolab/colab-vscode/issues/new?template=feature_request.md)
- 💬 [Discussions](https://github.com/googlecolab/colab-vscode/discussions)

## Quick Start

1. Install [VS Code](https://code.visualstudio.com).
1. Install the Colab extension from either the [Visual Studio
   Marketplace](https://marketplace.visualstudio.com/items?itemName=google.colab)
   or [Open VSX](https://open-vsx.org/extension/Google/colab).
1. Open or create a notebook file.
1. When prompted, sign in.
1. Click `Select Kernel` > `Colab` > `Auto Connect`.
1. 😎 Enjoy!

![Connecting to a new Colab server and executing a code
cell](./docs/assets/hello-world.gif)

See our [user guide](https://github.com/googlecolab/colab-vscode/wiki/User-Guide)
for more things you can do!

## Commands

Activate the command palette with `Ctrl+Shift+P` or `Cmd+Shift+P` on Mac.

| Command                                  | Description                                                         |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `Colab: Remove Server`                   | Select an assigned Colab server to remove.                          |
| `Colab: Sign Out`                        | Sign out of the active Colab account.                               |
| `Colab: Sign Out of All Accounts`        | Sign out of every signed-in Google account.                         |
| `Colab: Add Account`                     | Sign in an additional Google account.                               |
| `Colab: Switch Account`                  | Use a different signed-in Google account.                           |
| `Colab: Manage Accounts`                 | Add, switch or remove Google accounts.                              |
| `Colab: Mount Google Drive to Server...` | Append a code snippet to the active notebook to mount Google Drive. |

## Multiple Accounts

Several Google accounts can be signed in at once. One is _active_ at a time and
serves every Colab request; the status bar shows which one, and `+N` next to it
means N further accounts are standing by.

When the active account runs out of Colab quota, the extension switches to the
next signed-in account and re-creates the server with the **same** accelerator,
machine shape, runtime version and alias, then notifies you.

| Setting                                     | Default | Description                                                                             |
| ------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `colab.multiAccount.autoSwitch`             | `true`  | Switch to the next account automatically when the active one is out of quota.           |
| `colab.multiAccount.releaseServersOnSwitch` | `true`  | Delete the exhausted account's servers before switching. **Destroys any data on them.** |

Assigned servers are stored per account, so switching accounts swaps in that
account's servers rather than showing the previous account's.

> **Note:** using multiple accounts to work around Colab's resource limits may
> violate the [Colab Terms of
> Service](https://research.google.com/colaboratory/tos_v5.html). Use at your own
> risk.

## Contributing

Contributions are welcome and appreciated! See the [contributing
guide](./docs/contributing.md) for more info.

## Data and Telemetry

This extension collects identifiable usage data and error reports to improve your
experience. Telemetry collection respects VS Code's built-in telemetry setting.
To opt out, set `telemetry.telemetryLevel` to `"off"` in your VS Code settings.

See Colab's
[Terms of Service](https://research.google.com/colaboratory/tos_v5.html) and the
[Google Privacy Policy](https://policies.google.com/privacy), which apply to
usage of this extension.

## Security Disclosures

Please see our [security disclosure process](./SECURITY.md). All [security
advisories](https://github.com/googlecolab/colab-vscode/security/advisories) are
managed on GitHub.
