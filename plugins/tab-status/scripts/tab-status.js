#!/usr/bin/env node
"use strict";

/**
 * tab-status: set the terminal tab title to a status dot plus the project name.
 *
 * Invoked by Claude Code hooks with a custom mode argument (configured in hooks.json):
 *
 *     tab-status.js free      // SessionStart                     - new session, nothing running
 *     tab-status.js busy      // UserPromptSubmit                 - the main agent starts a turn
 *     tab-status.js waiting   // PermissionRequest                - a permission prompt or question opens
 *     tab-status.js tool      // PostToolUse, PostToolUseFailure  - the tool that asked has run, so its prompt was answered
 *     tab-status.js check     // Stop, StopFailure, SubagentStop  - the main agent or a subagent finished
 *     tab-status.js end       // SessionEnd                       - deletes the session's state file
 *
 * The dot is the first of these that applies:
 *
 *     blue    // an agent has a permission prompt or question open
 *     red     // the main agent is working on a turn
 *     yellow  // the main agent is free, background work is still running
 *     green   // nothing is running
 *
 * Each hook call is a new process, so what the earlier hooks reported is kept in a small JSON
 * file per session (see readState). Every mode reads the hook payload on stdin: "check" uses
 * Claude Code's background_tasks snapshot, and every mode that writes a title uses
 * transcript_path to read the session's current name. Needs CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
 * so Claude Code's own title updates don't compete, and it only works in interactive sessions
 * (in `claude -p` there's no terminal and the sequence is dropped).
 *
 * The title text is the name set with Claude Code's built-in /rename for this session,
 * or the current folder name if the session hasn't been renamed. /rename stores its value
 * in the session transcript, so it survives resume and we just read it back (see
 * readRenameTitle).
 *
 * Esc fires no hook, so after an interrupt the dot stays as it was until the next prompt.
 *
 * On an unexpected error this just throws. Node exits 1, which Claude Code shows
 * as a one-line "tab-status hook error" notice (full detail in the debug log) and
 * otherwise ignores. Only exit 2 blocks a Stop, and this never uses it, so the
 * worst case is the title not updating for one event, and the error stays visible
 * instead of silently hidden.
 */

const {basename, dirname, join}                        = require("node:path");
const {mkdirSync, readFileSync, rmSync, writeFileSync} = require("node:fs");

const isWindows = process.platform === "win32"; // true on native Windows, false in WSL

// squares on native Windows, circles everywhere else (including WSL), so you can tell a Windows tab from a WSL/Linux one at a glance
const DOT             = isWindows
                        ? {free: "🟩", pending: "🟨", busy: "🟥", waiting: "🟦"}
                        : {free: "🟢", pending: "🟡", busy: "🔴", waiting: "🔵"};
const ACTIVE_STATUSES = new Set(["running", "pending"]);

main();

//region Main

/**
 * Entry point of the script.
 * Reads the hook payload, works out the status for the given mode, and writes the title.
 *
 * @returns {void}
 */
function main() {
  const mode      = process.argv[2] ?? "free"; // custom mode argument defined in hooks.json
  const payload   = readPayload();             // hook payload on stdin
  const stateFile = join(process.env.CLAUDE_PLUGIN_DATA, `${payload.session_id}.json`); // Claude Code sets CLAUDE_PLUGIN_DATA for plugin hooks

  if (mode === "end") {
    rmSync(stateFile, {force: true}); // force: no error when the session never wrote one
    return;
  }

  const state  = readState(stateFile);
  const status = nextStatus(mode, payload, state);
  if (status) {
    writeState(stateFile, state);
  }
  writeOutput(mode, payload, status);
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
//region Session State

/**
 * Read what this session's earlier hooks reported.
 *
 *     busy       // true while the main agent is in a turn (UserPromptSubmit until Stop)
 *     waiting    // who has a prompt open and for which tool, e.g. {main: "AskUserQuestion", a1b2c3: "Bash"}
 *
 * The keys of `waiting` are "main" for the main agent and the agent_id for a subagent.
 *
 * @param {string} stateFile - Path of the session's state file.
 * @returns {{busy: boolean, waiting: Object<string, string>}} The saved state, or the starting state.
 */
function readState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {busy: false, waiting: {}}; // first hook of the session, or another hook is writing the file right now
  }
}

/**
 * Save the session's state for the next hook call.
 *
 * @param {string} stateFile - Path of the session's state file.
 * @param {{busy: boolean, waiting: Object<string, string>}} state - The state to save.
 * @returns {void}
 */
function writeState(stateFile, state) {
  mkdirSync(dirname(stateFile), {recursive: true});
  writeFileSync(stateFile, JSON.stringify(state));
}

/**
 * Apply one hook event to the session state and pick the status to show.
 * Changes `state` in place. Returns null when the title stays as it is; `state` is unchanged then.
 *
 *     nextStatus("busy", payload, state);     // "busy": state.busy is now true
 *     nextStatus("tool", payload, state);     // null unless this agent was waiting on payload.tool_name
 *
 * @param {string} mode - The custom mode string (from hooks.json).
 * @param {object} payload - The hook payload.
 * @param {{busy: boolean, waiting: Object<string, string>}} state - The session state, updated in place.
 * @returns {"waiting"|"busy"|"pending"|"free"|null} The status to show, or null to leave the title alone.
 */
function nextStatus(mode, payload, state) {
  const agent        = payload.agent_id ?? "main";       // who the hook fired in: the main agent or a subagent
  const tasks        = payload.background_tasks ?? [];   // only Stop and SubagentStop send this
  let backgroundWork = false;

  if (mode === "free") {
    if (payload.source === "compact") {
      return null; // compaction also fires SessionStart, often in the middle of a turn, and changes nothing the dot shows
    }
    state.busy    = false;
    state.waiting = {};
  }
  else if (mode === "busy") {
    state.busy = true;
    delete state.waiting.main; // a new turn means the main agent's prompt is closed
  }
  else if (mode === "waiting") {
    state.waiting[agent] = payload.tool_name;
  }
  else if (mode === "tool") {
    // this runs after every tool call, so anything but the tool that asked exits here, before a file is read or written
    if (state.waiting[agent] !== payload.tool_name) {
      return null;
    }
    delete state.waiting[agent];
    backgroundWork = agent !== "main"; // a subagent still running once the main agent is free is background work
  }
  else if (mode === "check") {
    if (payload.hook_event_name === "SubagentStop") {
      if (state.busy && !(agent in state.waiting)) {
        return null; // the main agent is still in its turn, so the dot stays red
      }
      delete state.waiting[agent];
    }
    else { // Stop, StopFailure
      state.busy = false;
      delete state.waiting.main;
      // an interrupted subagent never reports that its prompt closed, so drop the ones no longer listed (StopFailure sends no list)
      if (payload.background_tasks) {
        for (const waitingAgent of Object.keys(state.waiting)) {
          if (!tasks.some((task) => task.id === waitingAgent)) {
            delete state.waiting[waitingAgent];
          }
        }
      }
    }
    // a finishing agent still lists itself as running, so exclude it or the last one to finish stays stuck on yellow
    backgroundWork = tasks.some((task) => task.id !== payload.agent_id && ACTIVE_STATUSES.has(task.status));
  }

  if (Object.keys(state.waiting).length > 0) {
    return "waiting";
  }
  if (state.busy) {
    return "busy";
  }
  return backgroundWork ? "pending" : "free";
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
 * Build the terminal sequence that sets the tab title to the status dot plus the session's name.
 *
 * @param {"waiting"|"busy"|"pending"|"free"} status - The status to show.
 * @param {object} payload - The hook payload containing the session transcript path.
 * @returns {string} An OSC 0 title sequence.
 */
function titleSequence(status, payload) {
  const ESC         = String.fromCharCode(27); // 0x1b
  const BEL         = String.fromCharCode(7);  // 0x07
  const TITLE_START = `${ESC}]0;`;             // OSC 0 sequence prefix to set window/tab title
  const TITLE_END   = BEL;                     // OSC sequence terminator

  // set title to the session's /rename value if set, else the current folder name (proxy for project name)
  const label     = readRenameTitle(payload.transcript_path) || basename(process.cwd());
  // OSC strings end at BEL or ESC; strip control bytes so a /rename value or folder
  // name can't end the title sequence early and inject its own terminal escapes.
  const safeLabel = label.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const title     = `${DOT[status]} ${safeLabel}`;

  return `${TITLE_START}${title}${TITLE_END}`;
}

/**
 * Write the hook's JSON output: the title sequence in the `terminalSequence` field, which Claude Code
 * writes to the terminal for us, plus the session start message. Writes nothing when there is neither.
 *
 * @param {string} mode - The custom mode string (from hooks.json).
 * @param {object} payload - The hook payload containing the session transcript path.
 * @param {"waiting"|"busy"|"pending"|"free"|null} status - The status to show, or null to leave the title alone.
 * @returns {void}
 */
function writeOutput(mode, payload, status) {
  const output = {};
  if (status) {
    output.terminalSequence = titleSequence(status, payload);
  }

  // at session start, attach a message: when configured, a one-line summary of what the dots
  // mean; when not, a nudge plus additionalContext so Claude can offer to set the missing env var
  const message = sessionStartMessage(mode);
  if (message) {
    output.systemMessage = message.systemMessage;
    if (message.additionalContext) {
      output.hookSpecificOutput = {hookEventName: "SessionStart", additionalContext: message.additionalContext};
    }
  }

  if (Object.keys(output).length > 0) {
    process.stdout.write(JSON.stringify(output));
  }
}

//endregion
