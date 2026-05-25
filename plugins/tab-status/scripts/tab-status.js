#!/usr/bin/env node
"use strict";

/**
 * tab-status: set the terminal tab title to a status dot plus the project name.
 *
 * Invoked by Claude Code hooks with a custom mode argument (configured in hooks.json):
 *
 *     tab-status.js free      // green  - session start; nothing running
 *     tab-status.js check     // yellow - main agent free, background work running
 *     tab-status.js busy      // red    - main agent is processing a prompt
 *
 * Every mode reads the hook payload on stdin: "check" uses Claude Code's
 * background_tasks snapshot, and all modes use transcript_path to read the session's
 * current name. Needs CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 so Claude Code's own title
 * updates don't compete, and it only works in interactive sessions (in `claude -p`
 * there's no terminal and the sequence is dropped).
 *
 * The title text is the name set with Claude Code's built-in /rename for this session,
 * or the current folder name if the session hasn't been renamed. /rename stores its value
 * in the session transcript, so it survives resume and we just read it back (see
 * readRenameTitle).
 *
 * On an unexpected error this just throws. Node exits 1, which Claude Code shows
 * as a one-line "tab-status hook error" notice (full detail in the debug log) and
 * otherwise ignores. Only exit 2 blocks a Stop, and this never uses it, so the
 * worst case is the title not updating for one event, and the error stays visible
 * instead of silently hidden.
 */

const {basename}     = require("node:path");
const {readFileSync} = require("node:fs");

const isWindows = process.platform === "win32"; // true on native Windows, false in WSL

main();

//region Main

/**
 * Entry point of the script.
 * Reads the hook payload and updates the tab status for the given mode.
 *
 * @returns {void}
 */
function main() {
  const mode    = process.argv[2] ?? "free"; // custom mode argument defined in hooks.json
  const payload = readPayload();             // hook payload on stdin: background_tasks (check) and transcript_path (all modes)

  writeTitleStatus(mode, payload);
}

/**
 * Parse the hook payload from stdin.
 *
 * @returns {object} The parsed hook payload, or an empty object if absent or unparseable.
 */
function readPayload() {
  try {
    const stdin = readFileSync(0, "utf8") || "{}";
    return JSON.parse(stdin);
  } catch {
    return {};
  }
}

//endregion
//region Session Start Message

/**
 * Build the message shown at session start (the "free" mode, fired by SessionStart).
 *
 * When configured (CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1), returns a one-line systemMessage
 * summarizing what the dots mean and how to set a custom title.
 *
 * When not configured, returns a systemMessage nudging the user plus additionalContext so Claude
 * can offer to add the setting: tab-status needs that env var set so Claude Code stops managing the
 * terminal title itself; without it, Claude Code overwrites the plugin's status dot.
 *
 * @param {string} mode - The custom mode string; only "free" (SessionStart) returns a message.
 * @returns {{systemMessage: string, additionalContext?: string}|null} The message, or null outside session start.
 */
function sessionStartMessage(mode) {
  if (mode !== "free") {
    return null; // only session start shows a message
  }

  // fully configured: one-line reminder of what the dots mean and how to set a custom title
  if (process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE === "1") {
    // wrap the hotkey in resets (0m = terminal default) so it shows in normal-bright
    // text against the dimmer system-message styling
    const reset = "\x1b[0m"; // reset all attributes
    // WT_SESSION is set by Windows Terminal (and inherited by child processes), so it's only true when hosted there
    const wtTip = process.env.WT_SESSION
      ? `\nWindows Terminal: Opens a new tab in this folder: ${reset}Ctrl+Shift+D${reset}`
      : "";
    return {
      systemMessage: `\ntab-status plugin: /rename <name> sets a custom title, /rename alone picks one for you. Takes effect next turn.${wtTip}`,
    };
  }

  // not configured: nudge the user, and give Claude context so it can offer to fix it
  return {
    // shown directly to the user
    systemMessage: "\ntab-status setup: Type `/update-config CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` so the plugin can control the title instead of Claude Code.",
    // added to Claude's context so it can offer to fix it
    additionalContext: "The tab-status plugin is installed but not fully configured. Ask user if they'd like you to run `/update-config CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` so the tab-setup plugin can control the title instead of Claude Code. ",
  };
}

//endregion
//region Update Title

/**
 * Read this session's name as set by Claude Code's built-in /rename.
 * /rename appends a "custom-title" record to the session transcript; the last such record
 * is the current name. We jump to the final occurrence with lastIndexOf and parse only that
 * line, so the read stays cheap even on a large transcript.
 *
 * @param {string|undefined} transcriptPath - The session transcript path from the hook payload.
 * @returns {string} The /rename value, or an empty string if the session hasn't been renamed.
 */
function readRenameTitle(transcriptPath) {
  if (!transcriptPath) {
    return "";
  }

  let data;
  try {
    data = readFileSync(transcriptPath, "utf8");
  } catch {
    return ""; // transcript not readable yet
  }

  const idx = data.lastIndexOf('"type":"custom-title"');
  if (idx === -1) {
    return ""; // session has not been renamed
  }

  const lineStart = data.lastIndexOf("\n", idx) + 1; // char offset into data, not a line number
  let lineEnd     = data.indexOf("\n", idx);
  if (lineEnd === -1) {
    lineEnd = data.length;
  }

  // data.slice(lineStart, lineEnd) is the single matched transcript line (one JSON object per line), e.g.:
  //   {"type":"custom-title","customTitle":"refactor-documentation", ...}
  try {
    const record = JSON.parse(data.slice(lineStart, lineEnd));
    return typeof record.customTitle === "string" ? record.customTitle.trim() : "";
  } catch {
    return ""; // partial or malformed record, fall back to the folder name
  }
}

/**
 * Decide the status dot based on the custom mode argument (from hooks.json) and payload, then write JSON output.
 * We return the sequence in the `terminalSequence` field on stdout for Claude Code to write.
 *
 * @param {string} mode - The custom mode string (from hooks.json).
 * @param {object} payload - The hook payload containing background task status and the session transcript path.
 * @returns {void}
 */
function writeTitleStatus(mode, payload) {
  // squares on native Windows, circles everywhere else (including WSL), so you can tell a Windows tab from a WSL/Linux one at a glance
  const DOT             = isWindows
                          ? {free: "🟩", pending: "🟨", busy: "🟥"}
                          : {free: "🟢", pending: "🟡", busy: "🔴"};
  const ACTIVE_STATUSES = new Set(["running", "pending"]);

  // get the right dot for this custom mode; "check" mode checks if any other background tasks are still active
  let dot = DOT.free;
  if (mode === "busy") {
    dot = DOT.busy;
  }
  else if (mode === "check") {
    // agent_id is set on SubagentStop (undefined on Stop); a finishing agent still lists itself
    // as running, so exclude it or the last one to finish stays stuck on yellow.
    const ownAgentId = payload.agent_id;
    const tasks      = payload.background_tasks ?? [];
    const running    = tasks.some((task) => task.id !== ownAgentId && ACTIVE_STATUSES.has(task.status));
    dot              = running ? DOT.pending : DOT.free;
  }

  // construct terminal sequence to set title
  const ESC         = String.fromCharCode(27); // 0x1b
  const BEL         = String.fromCharCode(7);  // 0x07
  const TITLE_START = `${ESC}]0;`;             // OSC 0 sequence prefix to set window/tab title
  const TITLE_END   = BEL;                     // OSC sequence terminator

  // set title to the session's /rename value if set, else the current folder name (proxy for project name)
  const label     = readRenameTitle(payload.transcript_path) || basename(process.cwd());
  // OSC strings end at BEL or ESC; strip control bytes so a /rename value or folder
  // name can't end the title sequence early and inject its own terminal escapes.
  const safeLabel = label.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const title     = `${dot} ${safeLabel}`;
  const sequence  = `${TITLE_START}${title}${TITLE_END}`;

  const output = {terminalSequence: sequence};

  // at session start, attach a message: when configured, a one-line summary of what the dots
  // mean; when not, a nudge plus additionalContext so Claude can offer to set the missing env var
  const message = sessionStartMessage(mode);
  if (message) {
    output.systemMessage = message.systemMessage;
    if (message.additionalContext) {
      output.hookSpecificOutput = {hookEventName: "SessionStart", additionalContext: message.additionalContext};
    }
  }

  process.stdout.write(JSON.stringify(output));
}

//endregion
