/**
 * The push gate: who may reach the user's phone, and for how long.
 *
 * The host smoke test drives the plugin end to end; this file pins the one rule
 * that decides everything else, in the matrix a smoke run has no room for. The
 * rule is: nothing is pushed unless the user's own instruction names the trigger
 * word, a watch was opened for the turn that is running now, and the deployment
 * switches allow that class of event.
 *
 * Two of the cases here are regressions against a live harness, and both were
 * invisible to the suite that existed when they happened:
 *
 *   1. A watch from an earlier turn is spent, but the tool used to see "this
 *      session has a watch" and decline to open one for the current turn. Every
 *      turn after the first was then refused as unauthorised, so the second task
 *      the user asked to be told about was the last one that could ever be told.
 *   2. Closing the watch at the end of a turn meant appending to the session from
 *      inside the `turn/end` observer. dsh refuses an append made while another
 *      append is being published, so the close never happened - which is what
 *      produced case 1. The gate now reads the expiry off the log position
 *      instead, and the stub below refuses a re-entrant append the way dsh does,
 *      so the mistake cannot come back unnoticed.
 *
 * Usage: node test/watch-lifecycle.mjs
 */

import { createServer } from "node:http";

let failures = 0;
let checks = 0;

/** Assert one condition, recording the outcome instead of aborting the run. */
function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL ${label}${detail === undefined ? "" : `\n       ${detail}`}\n`);
}

/** Assert deep equality through JSON, the cheapest structural comparison here. */
function equal(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, label, `expected ${b}\n       actual   ${a}`);
}

/** Assert that a string contains a fragment. */
function contains(haystack, needle, label) {
  const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  ok(text.includes(needle), label, `missing ${JSON.stringify(needle)} in ${JSON.stringify(text)}`);
}

/** Sleep, so a fire-and-forget event push can settle. */
const settle = (ms = 30) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Await a predicate, so the timing of a push never has to be guessed. */
async function until(predicate, label, tries = 60) {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return true;
    await settle(10);
  }
  process.stdout.write(`  note ${label}: condition never became true\n`);
  return false;
}

/* ------------------------------------------------------------------ fixtures */

const WORKSPACE_CWD = "C:/work/beacon-project";
const STUB_PROMPT = "run the migration, and beacon me about it";

/**
 * One message event, shaped like the ones a live harness writes.
 *
 * `user/message` with `source.kind: "user"` is the human; the same event type carries
 * runtime-context snapshots and skill catalogs under another `source.kind`, and a
 * reminder is not a request.
 */
function messageEvent(text, options = {}) {
  return {
    type: options.type ?? "user/message",
    data: {
      role: "user",
      source: { kind: options.kind ?? "user" },
      content: [{ type: "text", text }]
    }
  };
}

/**
 * A session stub shaped like the documented `session/event` callback argument.
 *
 * `append` refuses to re-enter, exactly as dsh does while it publishes an event, so a
 * plugin that answers an event by writing to the log fails here instead of silently
 * losing the write in production.
 */
function fakeSession(options = {}) {
  const turn = options.turn ?? 1;
  const prompt = options.prompt ?? STUB_PROMPT;
  const appended = [];
  const seed = [
    { type: "turn/start", data: { turn } },
    ...options.seed ?? [],
    ...prompt === "" ? [] : [messageEvent(prompt, options.message)]
  ];
  const session = {
    id: `session-${String(turn)}-${String(Math.random()).slice(2, 8)}`,
    header: { cwd: WORKSPACE_CWD },
    /** Set while a dispatch runs, so a re-entrant append is refused. */
    dispatching: false,
    appended,
    get events() {
      return [...seed, ...appended];
    },
    append(type, data) {
      if (session.dispatching === true) {
        throw new Error("session append cannot reenter while another append is being published");
      }
      appended.push({ type, data });
      return { type, data };
    },
    /** What the harness does between instructions: end the turn, open the next one. */
    nextTurn(next, instruction) {
      appended.push({ type: "turn/end", data: { turn: next - 1, reason: { kind: "completed" } } });
      appended.push({ type: "turn/start", data: { turn: next } });
      appended.push(messageEvent(instruction));
      return session;
    }
  };
  return session;
}

/**
 * Build a hand-made context for the row under test.
 *
 * The routes are never mounted: this file is about the gate, and a route needs a
 * webserver the gate does not. The effects are recorded so nothing here depends on
 * `webServer` being present.
 */
function makeCtx(base) {
  const state = {
    tools: new Map(),
    listeners: new Map(),
    sections: new Map(),
    effects: [],
    logs: [],
    config: { ...base }
  };
  const ctx = {
    tools: {
      register(tool) {
        state.tools.set(tool.name, tool);
      }
    },
    systemPrompt: {
      section(definition) {
        state.sections.set(definition.name, definition);
        return () => state.sections.delete(definition.name);
      }
    },
    workspaceRegistry: {
      resolveByPath: async () => ({ title: "beacon-workspace" })
    },
    settings: {
      update: async (ns, patch) => {
        Object.assign(state.config, patch);
      },
      mutate: async (ns, ops) => {
        for (const op of ops) for (const path of op.path) delete state.config[path];
      }
    },
    logger: {
      warn: (message) => state.logs.push(["warn", String(message)]),
      error: (message) => state.logs.push(["error", String(message)])
    },
    effect(fn) {
      state.effects.push(fn);
      return () => {};
    },
    on(name, listener) {
      const list = state.listeners.get(name) ?? [];
      list.push(listener);
      state.listeners.set(name, list);
      return () => {};
    }
  };
  return { ctx, state };
}

/** A local Feishu stand-in recording every request it receives. */
async function startWebhook() {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ url: req.url, raw: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, msg: "success" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    received,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Emit one session event into every hook, the way an append does. */
function emit(state, session, event) {
  session.dispatching = true;
  try {
    for (const listener of state.listeners.get("session/event") ?? []) listener(session, event);
  } finally {
    session.dispatching = false;
  }
}

/* --------------------------------------------------------------------- setup */

const webhook = await startWebhook();
const { ctx, state } = makeCtx({
  webhookUrl: `${webhook.origin}/open-apis/bot/v2/hook/beacon`,
  secret: "",
  enabled: true,
  prefix: "",
  notifyQuestion: true,
  notifyApproval: true,
  notifyError: true,
  maxChars: 3000,
  format: "card",
  publicUrl: ""
});

let mod;
try {
  mod = await import(new URL("../lib/index.js", import.meta.url).href);
} catch (error) {
  process.stdout.write([
    "",
    "Cannot load ../lib/index.js.",
    "The host imports resolve through the workspace's own node_modules:",
    "",
    "  npm install --ignore-scripts --cache .npm-cache",
    "",
    `underlying error: ${String(error?.message ?? error)}`,
    ""
  ].join("\n"));
  await webhook.close();
  process.exit(1);
}

/** Apply the row with a resolved configuration, the way the Loader re-runs it. */
function resolve(patch = {}) {
  Object.assign(state.config, patch);
  state.tools.clear();
  state.listeners.clear();
  state.sections.clear();
  state.effects.length = 0;
  mod.apply(ctx, mod.Config(state.config));
  return state.tools.get("dsh_beacon");
}

/** Call the tool the way the model does, reporting the refusal instead of throwing. */
const callTool = (tool, session, args) => tool.execute(
  { watch: true, ...args },
  { agent: { session }, callId: `call-${String(session.id)}`, signal: undefined }
).then(
  (value) => ({ value }),
  (error) => ({ error: String(error?.message ?? error) })
);

const questionEvent = (callId) => ({
  type: "tool/call",
  data: {
    name: "ask_user_question",
    callId,
    arguments: JSON.stringify({ questions: [{ id: "q", question: "Which engine?" }] })
  }
});

const approvalEvent = (callId) => ({
  type: "approval/asked",
  data: { id: callId, toolName: "pwsh", callId, reason: "writes outside the workspace" }
});

const failureEvent = (time, message) => ({
  type: "turn/end",
  time,
  data: { turn: 1, reason: { kind: "error", error: { message, code: "X" } } }
});

/* --------------------------------------------------------------------- suite */

process.stdout.write("\n1. nothing reaches the user before the tool opens a watch\n");
const tool = resolve();
const quiet = fakeSession({ prompt: "migrate the schema while I step away" });
const beforeQuiet = webhook.received.length;
emit(state, quiet, questionEvent("q-quiet"));
emit(state, quiet, approvalEvent("a-quiet"));
emit(state, quiet, failureEvent("2026-01-01T00:00:01.000Z", "quiet failure"));
await settle(40);
equal(webhook.received.length, beforeQuiet,
  "a session no watch was opened on pushes nothing: questions, approvals and failures included");

process.stdout.write("\n2. the tool refuses a call that does not ask for a watch\n");
const beforeRefusal = webhook.received.length;
const refused = await tool.execute(
  { message: "nobody asked for this" },
  { agent: { session: quiet }, callId: "call-nowatch", signal: undefined }
).then((value) => ({ value }), (error) => ({ error: String(error?.message ?? error) }));
contains(refused.error, "no watch covers this turn", "the refusal says what is missing");
equal(webhook.received.length, beforeRefusal, "the refused call pushed nothing");
equal(quiet.appended.filter((event) => event.type === "beacon/watch").length, 0,
  "a refused call does not leave a watch behind");

process.stdout.write("\n3. the tool arms the turn it asks to watch\n");
// The instruction deliberately says nothing about notifications: the wording is not
// what opens a watch, the tool's own watch:true call is.
const first = fakeSession({ prompt: "rebuild the indexes, this will take a while" });
const beforeFirst = webhook.received.length;
const opened = await callTool(tool, first, { message: "1/4: the migration is planned", kind: "plan" });
equal(opened.value, { kind: "plan", delivered: true }, "the milestone is delivered");
equal(webhook.received.length, beforeFirst + 1, "the milestone reached the webhook");
equal(first.appended.filter((event) => event.type === "beacon/watch").length, 1, "the watch was recorded once");
emit(state, first, questionEvent("q-first"));
ok(await until(() => webhook.received.length === beforeFirst + 2, "question after arming"),
  "the event layer reports to the same turn the tool armed");

process.stdout.write("\n4. a spent watch does not lock the next task out\n");
// The regression this file exists for: the log still holds turn 1's watch, so a gate
// that asks "has this session ever been watched" answers yes, declines to arm turn 2,
// and then refuses every push in it.
first.nextTurn(2, "now the indexes");
const beforeSpent = webhook.received.length;
emit(state, first, approvalEvent("a-spent"));
await settle(40);
equal(webhook.received.length, beforeSpent, "a new turn starts unarmed, whatever the previous turn did");

const reopened = await callTool(tool, first, { message: "2/4: the indexes are rebuilt", kind: "progress" });
equal(reopened.value, { kind: "progress", delivered: true },
  "the next task can arm its own turn instead of being refused");
const beforeReopened = webhook.received.length;
emit(state, first, approvalEvent("a-reopened"));
ok(await until(() => webhook.received.length === beforeReopened + 1, "approval after re-arming"),
  "the re-armed turn reports its own questions and approvals");

process.stdout.write("\n5. handling an event never writes to the session log\n");
// A close recorded from the `turn/end` observer cannot land: dsh refuses an append
// made while another append is being published. The stub refuses it too, so this
// asserts the gate has no such write rather than trusting that it does not.
const failing = fakeSession();
await callTool(tool, failing, { message: "1/2: starting", kind: "plan" });
const beforeFailure = webhook.received.length;
state.logs.length = 0;
emit(state, failing, failureEvent("2026-01-01T00:00:02.000Z", "provider returned 429"));
ok(await until(() => webhook.received.length === beforeFailure + 1, "failure push"),
  "a failed turn still reaches the user");
await settle(40);
equal(state.logs.filter(([, message]) => message.includes("could not record")).length, 0,
  "no state is written from the observer, so no write is ever refused");
equal(failing.appended.filter((event) => event.type === "beacon/unwatch").length, 0,
  "there is no close event to write: the turn boundary is the close");

process.stdout.write("\n6. the switches outrank the watch\n");
resolve({ notifyError: false });
const quietError = fakeSession();
await callTool(tool, quietError, { message: "1/2: starting", kind: "plan" });
const beforeSwitch = webhook.received.length;
emit(state, quietError, failureEvent("2026-01-01T00:00:03.000Z", "switched off"));
await settle(40);
equal(webhook.received.length, beforeSwitch, "notifyError:false suppresses the failure, watched or not");
emit(state, quietError, questionEvent("q-switch"));
ok(await until(() => webhook.received.length === beforeSwitch + 1, "question with notifyError off"),
  "the classes stay independent: turning one off leaves the others alone");

resolve({ enabled: false });
const disabled = await callTool(tool, quietError, { message: "should not pass" });
contains(disabled.error, "disabled", "the master switch makes the tool refuse");
const beforeDisabled = webhook.received.length;
emit(state, quietError, approvalEvent("a-disabled"));
await settle(40);
equal(webhook.received.length, beforeDisabled, "the master switch silences the event layer too");
resolve({ enabled: true, notifyError: true });

process.stdout.write("\n7. the watch comes from the tool's call, not from a message\n");
// The plugin does not read the user's message at all any more. A session with no
// instruction still arms on the model's request, and an instruction that asks for
// quiet is not examined either - the turn boundary is what closes a watch.
const bare = fakeSession({ prompt: "" });
const bareOpened = await callTool(tool, bare, { message: "1/2: starting", kind: "plan" });
equal(bareOpened.value, { kind: "plan", delivered: true },
  "a session with no instruction at all still arms on the tool's own request");
const beforeBareEvent = webhook.received.length;
emit(state, bare, questionEvent("q-bare"));
ok(await until(() => webhook.received.length === beforeBareEvent + 1, "question on the bare session"),
  "the armed turn reports, whatever the user's message said");

webhook.received.length = 0;
await webhook.close();

process.stdout.write(`\n${String(checks - failures)}/${String(checks)} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${String(failures)} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("watch-lifecycle: PASS\n");
