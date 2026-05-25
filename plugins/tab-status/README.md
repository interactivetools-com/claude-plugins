# tab-status

| 🟢 example.com | 🔴 example.com | 🔴 project-plan | 🟡 acme-store | + |
|----------------|----------------|-----------------|---------------|---|

Shows Claude's status in your terminal tab: a colored dot for what Claude is doing, plus the
project folder name so you can tell tabs apart at a glance.

| Tab             | State                                    |
|-----------------|------------------------------------------|
| 🟢 example.com  | idle, ready for input                    |
| 🔴 example.com  | working on your prompt (another session) |
| 🔴 project-plan | working on your prompt                   |
| 🟡 acme-store   | background agents or tasks still running |

On Windows (outside WSL) the dots render as squares (🟩 🟥 🟨), so when you run both Windows and
WSL terminals you can tell them apart at a glance.

## Install

- Install Node.js if you don't have it, from https://nodejs.org/en/download
- Run these inside Claude Code:

    ```
    /plugin marketplace add interactivetools-com/claude-plugins
    /plugin install tab-status@itools
    /update-config CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1   # stop Claude Code from overwriting the title
    ```
- Then restart Claude Code (`/exit`, then relaunch) to apply the changes.

## Custom title

By default the tab shows the project folder name. To override it for the current session, use
Claude Code's built-in rename:

```
# Manually set the tab title to "My Project"
/rename My Project

# Let Claude generate a title from the conversation
/rename
```

The tab updates on your next prompt, or when Claude stops.

Note: There's no built-in way to reset back to the folder name (Claude Code /rename limitation).
