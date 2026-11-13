"use strict";

/**
 * Tests for tab-status.js. Each test replays a sequence of hook events the way Claude Code sends
 * them (mode argument plus JSON payload on stdin) and checks the dot in the title the script returns.
 *
 * Run from the plugin folder:
 *
 *     node --test
 */

const {test}                                          = require("node:test");
const assert                                          = require("node:assert/strict");
const {spawnSync}                                     = require("node:child_process");
const {existsSync, mkdtempSync, rmSync, writeFileSync} = require("node:fs");
const {tmpdir}                                        = require("node:os");
const {join}                                          = require("node:path");

const SCRIPT  = join(__dirname, "..", "scripts", "tab-status.js");
const SESSION = "test-session";

// the script picks squares on native Windows and circles everywhere else
const DOT = process.platform === "win32"
            ? {green: "🟩", yellow: "🟨", red: "🟥", blue: "🟦"}
            : {green: "🟢", yellow: "🟡", red: "🔴", blue: "🔵"};

/**
 * Start a fake session: a temp folder for the state file and a function that sends one hook event.
 *
 *     const send = newSession(t);
 *     send("busy", {hook_event_name: "UserPromptSubmit"});   // returns DOT.red
 *
 * @param {import("node:test").TestContext} t - The test, used to delete the temp folder afterwards.
 * @returns {function(string, object=): (string|null)} Sends an event; returns the dot written, or null when no title was written.
 */
function newSession(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "tab-status-test-"));
  t.after(() => rmSync(dataDir, {recursive: true, force: true}));

  const send = (mode, payload = {}) => {
    const result = spawnSync(process.execPath, [SCRIPT, mode], {
      input:    JSON.stringify({session_id: SESSION, ...payload}),
      encoding: "utf8",
      cwd:      dataDir,
      env:      {...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1"},
    });
    assert.equal(result.status, 0, result.stderr);

    const sequence = result.stdout ? JSON.parse(result.stdout).terminalSequence : undefined;
    if (!sequence) {
      return null;
    }
    const title = sequence.slice("\x1b]0;".length, -1); // text between the OSC 0 prefix and the BEL
    return title.split(" ")[0];
  };
  send.stateFile = join(dataDir, `${SESSION}.json`);
  send.dataDir   = dataDir;

  return send;
}

const running = (id) => ({id, type: "subagent", status: "running"});

test("a turn goes red, then green when nothing is left running", (t) => {
  const send = newSession(t);

  assert.equal(send("free", {hook_event_name: "SessionStart", source: "startup"}), DOT.green);
  assert.equal(send("busy", {hook_event_name: "UserPromptSubmit"}), DOT.red);
  assert.equal(send("check", {hook_event_name: "Stop", background_tasks: []}), DOT.green);
});

test("Stop goes yellow while background work is running", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  assert.equal(send("check", {hook_event_name: "Stop", background_tasks: [running("a1")]}), DOT.yellow);
});

test("a subagent finishing during the main agent's turn leaves the title alone", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  // subagents the turn is blocked on are never in background_tasks
  assert.equal(send("check", {hook_event_name: "SubagentStop", agent_id: "a1", background_tasks: []}), null);
  // a background subagent finishing while the main agent is still working
  assert.equal(send("check", {hook_event_name: "SubagentStop", agent_id: "a2", background_tasks: [running("a2")]}), null);
});

test("background subagents finishing after the turn go yellow, then green for the last one", (t) => {
  const send  = newSession(t);
  const tasks = [running("a1"), running("a2")];

  send("busy", {hook_event_name: "UserPromptSubmit"});
  send("check", {hook_event_name: "Stop", background_tasks: tasks});
  assert.equal(send("check", {hook_event_name: "SubagentStop", agent_id: "a1", background_tasks: tasks}), DOT.yellow);
  // the last one to finish still lists itself as running
  assert.equal(send("check", {hook_event_name: "SubagentStop", agent_id: "a2", background_tasks: [running("a2")]}), DOT.green);
});

test("a prompt goes blue, and back to red when the tool that asked has run", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  assert.equal(send("waiting", {hook_event_name: "PermissionRequest", tool_name: "Bash"}), DOT.blue);
  assert.equal(send("tool", {hook_event_name: "PostToolUse", tool_name: "Read"}), null); // another tool from the same batch
  assert.equal(send("tool", {hook_event_name: "PostToolUse", tool_name: "Bash"}), DOT.red);
});

test("a background subagent's tool calls don't clear the main agent's prompt", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  send("waiting", {hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion"});
  assert.equal(send("tool", {hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", agent_id: "a1"}), null);
  assert.equal(send("tool", {hook_event_name: "PostToolUse", tool_name: "Bash", agent_id: "a1"}), null);
});

test("a background subagent's prompt goes blue, then yellow once answered", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  send("check", {hook_event_name: "Stop", background_tasks: [running("a1")]});
  assert.equal(send("waiting", {hook_event_name: "PermissionRequest", tool_name: "Edit", agent_id: "a1"}), DOT.blue);
  assert.equal(send("tool", {hook_event_name: "PostToolUse", tool_name: "Edit", agent_id: "a1"}), DOT.yellow);
});

test("blue stays through the main agent's Stop while a running subagent is still waiting", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  send("waiting", {hook_event_name: "PermissionRequest", tool_name: "Edit", agent_id: "a1"});
  assert.equal(send("check", {hook_event_name: "Stop", background_tasks: [running("a1")]}), DOT.blue);
  assert.equal(send("check", {hook_event_name: "SubagentStop", agent_id: "a1", background_tasks: [running("a1")]}), DOT.green);
});

test("Stop drops the prompt of a subagent that is no longer running", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  send("waiting", {hook_event_name: "PermissionRequest", tool_name: "Edit", agent_id: "a1"});
  assert.equal(send("check", {hook_event_name: "Stop", background_tasks: []}), DOT.green);
});

test("a subagent that finishes while waiting clears its prompt and shows the main agent's status", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  send("waiting", {hook_event_name: "PermissionRequest", tool_name: "Edit", agent_id: "a1"});
  assert.equal(send("check", {hook_event_name: "SubagentStop", agent_id: "a1", background_tasks: []}), DOT.red);
});

test("StopFailure ends the turn", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  assert.equal(send("check", {hook_event_name: "StopFailure"}), DOT.green);
  // the turn is over, so a background subagent finishing now updates the title again
  assert.equal(send("check", {hook_event_name: "SubagentStop", agent_id: "a1", background_tasks: [running("a1"), running("a2")]}), DOT.yellow);
});

test("SessionStart after compaction keeps the turn's status", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  assert.equal(send("free", {hook_event_name: "SessionStart", source: "compact"}), null);
  assert.equal(send("check", {hook_event_name: "SubagentStop", agent_id: "a1", background_tasks: []}), null); // still in the turn
});

test("a tool call with no prompt open writes no title and no state file", (t) => {
  const send = newSession(t);

  assert.equal(send("tool", {hook_event_name: "PostToolUse", tool_name: "Bash"}), null);
  assert.equal(existsSync(send.stateFile), false);
});

test("SessionEnd deletes the state file", (t) => {
  const send = newSession(t);

  send("busy", {hook_event_name: "UserPromptSubmit"});
  assert.equal(existsSync(send.stateFile), true);
  assert.equal(send("end", {hook_event_name: "SessionEnd"}), null);
  assert.equal(existsSync(send.stateFile), false);
});

test("the title is the /rename value with control bytes removed", (t) => {
  const send       = newSession(t);
  const transcript = join(send.dataDir, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({type: "custom-title", customTitle: "my\x07 \x1bproject"}) + "\n");

  const result = spawnSync(process.execPath, [SCRIPT, "busy"], {
    input:    JSON.stringify({session_id: SESSION, transcript_path: transcript}),
    encoding: "utf8",
    env:      {...process.env, CLAUDE_PLUGIN_DATA: send.dataDir},
  });

  assert.equal(JSON.parse(result.stdout).terminalSequence, `\x1b]0;${DOT.red} my project\x07`);
});
