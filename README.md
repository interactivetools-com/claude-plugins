# Claude Code Plugins by interactivetools.com

A marketplace of [Claude Code](https://claude.com/claude-code) plugins from interactivetools.com.

## Install

First, the prerequisites:

- Install Node.js if you don't have it, from https://nodejs.org/en/download
- On Windows, install Git Bash if you don't have it, from https://git-scm.com/download/win

Then, inside Claude Code, add the marketplace once and install any plugin from it:

```
/plugin marketplace add interactivetools-com/claude-plugins
/plugin install <plugin-name>@itools
```

Then restart Claude Code (`/exit`, then relaunch) to apply the changes.

## Available plugins

| Plugin                             | What it does                                                                                                                                                            |
|------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`tab-status`](plugins/tab-status) | Shows Claude's status in the terminal tab: green idle, red working, yellow when background agents are still running, plus the project folder name. e.g. [🟢 my-project] |

## License

MIT - see [LICENSE](LICENSE).
