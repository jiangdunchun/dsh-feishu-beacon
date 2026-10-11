/**
 * Host-half smoke test for dsh-feishu-beacon.
 *
 * No real DSH host and no real network: a local http server impersonates the
 * Feishu webhook and records what it receives, and a hand-built fake context
 * drives `apply`.
 *
 * On the settings model: the plugin owns no configuration scope. The test
 * stores a patch, resolves it against the plugin's own exported `Config`
 * schema, and re-applies the plugin — the order the runtime uses — so every
 * assertion below reads a row the plugin was actually handed. Asserting against
 * a configuration object the test built instead of the plugin's schema would
 * only ever test the test.
 *
 * Usage: node test/smoke.mjs
 */

import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

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

/** Sleep, so an async event-hook push can settle. */
const settle = (ms = 30) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Await a predicate, so tests never depend on a fixed guess at timing. */
async function until(predicate, label, tries = 60) {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return true;
    await settle(10);
  }
  process.stdout.write(`  note ${label}: condition never became true\n`);
  return false;
}

/* ------------------------------------------------------------------ fixtures */

/** The composition base config, read from the bundle patch rather than guessed. */
function readBaseConfig() {
  const yaml = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");
  const base = {};
  let inConfig = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (!inConfig) continue;
    const match = /^\s{8}([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, raw] = match;
    const value = raw.trim();
    if (value === "true") base[key] = true;
    else if (value === "false") base[key] = false;
    else if (value === "''") base[key] = "";
    else if (/^\d+$/.test(value)) base[key] = Number(value);
    else base[key] = value;
  }
  return base;
}

/**
 * Build a fake context and one settings row.
 *
 * The 0.2 settings service does not hand a plugin a configuration scope: the
 * Loader resolves the row's config against the plugin's `Config` schema and
 * passes it to `apply`, and an edit re-resolves it and re-runs `apply`. This
 * stub keeps that shape — `settings.update`/`settings.mutate` write the stored
 * patch, and the harness re-applies the plugin with the new values — so the
 * assertions below exercise the same path the runtime takes.
 *
 * @param base - the composition-layer config to start from.
 * @returns the fake context and the recorded state.
 */
function makeCtx(base) {
  const state = {
    tools: new Map(),
    listeners: new Map(),
    routes: new Map(),
    effects: [],
    logs: [],
    /** The stored configuration patch, as `settings.yaml`/the profile patch holds it. */
    config: { ...base },
    /** Every settings write, in order, for tests that assert on the channel used. */
    writes: [],
    /** The resolved config object the currently applied row was given. */
    resolved: undefined,
    /** Every command definition `apply` registered, by name. */
    commands: new Map()
  };
  const ctx = {
    tools: {
      register(tool) {
        state.tools.set(tool.name, tool);
      }
    },
    commands: {
      register(definition) {
        state.commands.set(definition.name, definition);
        return () => state.commands.delete(definition.name);
      }
    },
    on(event, handler) {
      const list = state.listeners.get(event) ?? [];
      list.push(handler);
      state.listeners.set(event, list);
    },
    logger: {
      info: (message) => state.logs.push(["info", String(message)]),
      warn: (message) => state.logs.push(["warn", String(message)]),
      error: (message) => state.logs.push(["error", String(message)])
    },
    settings: {
      /** Merge plain values into the stored patch. */
      async update(ns, patch) {
        state.writes.push({ ns, kind: "update", patch });
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete state.config[key];
          else state.config[key] = value;
        }
      },
      /** Apply ordered path edits; `unset` is how a stored credential is removed. */
      async mutate(ns, ops) {
        state.writes.push({ ns, kind: "mutate", ops });
        for (const op of ops) {
          if (op.op === "unset") delete state.config[op.path[0]];
          else state.config[op.path[0]] = op.value;
        }
      }
    },
    effect(fn) {
      state.effects.push(fn);
    },
    webServer: {
      register(route) {
        state.routes.set(route.path, route);
        return () => state.routes.delete(route.path);
      },
      unregister(path) {
        const previous = state.routes.get(path);
        state.routes.delete(path);
        return previous === undefined ? undefined : () => state.routes.set(path, previous);
      }
    },
    workspaceRegistry: {
      async resolveByPath(path) {
        if (path === WORKSPACE_CWD) return { id: "ws-1", path, title: "beacon-workspace" };
        return undefined;
      }
    }
  };
  return { ctx, state };
}

const WORKSPACE_CWD = "C:/work/beacon-project";

/**
 * Run the effects `apply` registered, then keep their disposers.
 *
 * `state.effects` is reset before each re-apply, so the maps always hold what the
 * row currently applied provides — exactly one config route, one test route, and
 * one `/beacon` command, all closing over the current configuration.
 *
 * @returns the disposers, so a test can prove teardown unmounts everything.
 */
function mountRoutes(state) {
  state.disposers = [];
  for (const effect of state.effects) {
    const dispose = effect();
    if (typeof dispose === "function") state.disposers.push(dispose);
  }
  return state.disposers;
}

/** A fake IncomingMessage carrying an optional JSON body. */
function fakeRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")];
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
}

/** A fake ServerResponse recording status, headers, and body. */
function fakeResponse() {
  const record = { status: 0, headers: {}, body: "" };
  return {
    record,
    writeHead(status, headers) {
      record.status = status;
      Object.assign(record.headers, headers ?? {});
    },
    write(chunk) {
      record.body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
    }
  };
}

/** Drive one registered route and return the recorded response. */
async function callRoute(state, path, method, body) {
  const route = state.routes.get(path);
  if (route === undefined) throw new Error(`route not registered: ${path}`);
  const res = fakeResponse();
  await route.handler(fakeRequest(method, body), res);
  let json;
  try {
    json = JSON.parse(res.record.body);
  } catch {
    json = undefined;
  }
  return { status: res.record.status, json, raw: res.record.body };
}

/**
 * A session stub shaped like the documented `session/event` callback argument.
 *
 * The watch state lives in the session log, so the stub keeps an append-only
 * list and exposes the whole log through `events` — a watch decision recorded by
 * one push is visible to the next, exactly as it is against a real session.
 */
function fakeSession(events) {
  const appended = [];
  return {
    id: "session-1",
    header: { cwd: WORKSPACE_CWD },
    appended,
    get events() {
      return [...events, ...appended];
    },
    append(type, data) {
      appended.push({ type, data });
      return { type, data };
    }
  };
}

/** Every event on a session stub, oldest first, whether seeded or appended. */
function sessionLogOf(session) {
  return [...(session.events ?? [])];
}

/**
 * The payload one recorded request carried, whether it was a card or text.
 *
 * Assertions read through here so they hold for both formats: a card has no
 * `content.text`, and a test that assumed one would only be testing the format
 * that happened to be configured.
 */
function payloadOf(entry) {
  return entry?.json ?? {};
}

/** Whether one recorded request is an interactive card. */
function isCard(entry) {
  return payloadOf(entry).msg_type === "interactive" && payloadOf(entry).card !== undefined;
}

/** Every text a payload carries: the body, and a card's header title and blocks. */
function payloadText(entry) {
  const payload = payloadOf(entry);
  if (payload.msg_type === "text") return payload.content?.text ?? "";
  const card = payload.card ?? {};
  const parts = [card.header?.title?.content ?? ""];
  for (const element of card.elements ?? []) {
    if (element?.text?.content !== undefined) parts.push(element.text.content);
  }
  return parts.join("\n");
}

/**
 * The same text, with the escaping a card applies undone.
 *
 * A card body is markdown, so `*`, `_`, `[` and backticks are escaped to keep
 * the model's own punctuation literal. Assertions about the *content* read
 * through here; assertions about the escaping read the raw text.
 */
function payloadTextRaw(entry) {
  return payloadText(entry).replace(/\\([\\*_~`[\]])/g, "$1");
}

/** The card header colour of one recorded request. */
function templateOf(entry) {
  return payloadOf(entry).card?.header?.template;
}

/** A local Feishu stand-in that records every request it receives. */
async function startWebhook() {
  const received = [];
  let rejectCards = false;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      received.push({ url: req.url, method: req.method, json, raw });
      // A group that will not take an interactive card answers with a non-zero
      // business code while the HTTP status stays 200 — which is exactly how
      // Feishu reports it, and why the sender has to read the body.
      if (rejectCards && json?.msg_type === "interactive") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 9499, msg: "card not supported in this chat" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, msg: "success" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    received,
    /** Make the stand-in refuse interactive cards, the way an unsupported group would. */
    refuseCards: (on) => {
      rejectCards = on === true;
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Emit one session event into every registered hook. */
function emit(state, session, event) {
  for (const listener of state.listeners.get("session/event") ?? []) listener(session, event);
}

/**
 * Open the watch on a session the way a user would.
 *
 * Event pushes are silent until a session is watched, so every test that expects
 * a question, approval, or failure to arrive has to watch the session first. It
 * goes through the real `/beacon on` path rather than writing the event itself,
 * so the tests exercise the mechanism they depend on.
 */
async function watchSession(state, session) {
  const definition = state.commands.get("beacon");
  if (definition === undefined) throw new Error("/beacon is not registered");
  const result = await definition.handler({ rawInput: "on", agent: { session }, signal: undefined, attachments: [] });
  if (result.kind !== "success") throw new Error(`could not watch the session: ${result.text}`);
  return result;
}

/* --------------------------------------------------------------------- suite */

const base = readBaseConfig();
const webhook = await startWebhook();
const { ctx, state } = makeCtx(base);

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

/**
 * Apply the plugin the way the Loader does: resolve the stored patch against
 * the plugin's `Config` schema, hand the result to `apply`, then mount the
 * routes its effects registered.
 *
 * A configuration edit in the runtime re-resolves the row and re-runs `apply`;
 * calling this after a settings write is what reproduces that.
 *
 * @returns the registered `dsh_beacon` tool.
 */
function resolve() {
  state.resolved = mod.Config({
    ...base,
    ...state.config
  });
  // A re-applied row replaces its own registrations, so the previous apply's
  // effects, hooks, and tool registration are dropped first — exactly what the
  // Loader does when it re-runs the entry.
  state.effects.length = 0;
  state.listeners.clear();
  state.tools.clear();
  state.commands.clear();
  // A re-applied row replaces what the previous apply registered rather than
  // stacking on it — the shell serves one handler per path, so a test harness
  // that let registrations accumulate would be testing its own bookkeeping.
  for (const dispose of state.disposers ?? []) dispose();
  state.routes.clear();
  mod.apply(ctx, state.resolved);
  mountRoutes(state);
  return state.tools.get("dsh_beacon");
}

/**
 * Edit the stored configuration through the settings service and re-apply, in
 * that order — exactly what the runtime does for a settings write. Every
 * assertion that follows reads the freshly applied row, so a value the plugin
 * did not re-read shows up as a failure rather than passing on a stale closure.
 *
 * @param patch - plain field values to merge.
 * @returns the tool of the re-applied row.
 */
async function edit(patch) {
  await ctx.settings.update("dsh-feishu-beacon", patch);
  return resolve();
}

const BEACON_URL = `${webhook.origin}/open-apis/bot/v2/hook/beacon`;
const SECRET = "beacon-signing-secret";
const CONFIG_PATH = "/api/dsh-feishu-beacon/config";
const TEST_PATH = "/api/dsh-feishu-beacon/test";

process.stdout.write("\n1. registration\n");
const tool = resolve();
ok(state.tools.has("dsh_beacon"), "registers the dsh_beacon tool");
ok((state.listeners.get("session/event") ?? []).length === 1, "hooks session/event once");
ok(state.routes.size === 2, "registers exactly 2 routes", `registered: ${[...state.routes.keys()].join(", ")}`);
equal(mod.inject, ["tools", "workspaceRegistry", "settings", "webServer", "commands"], "inject list");
ok(state.commands.has("beacon"), "registers the /beacon command");
ok(mod.name === "dsh-feishu-beacon", "plugin name");
ok(typeof mod.Config === "function" && mod.Config.type === "object",
  "exports the Config schema the settings service reads");
ok(mod.Config.dict.webhookUrl?.meta?.volatile === true, "webhookUrl is volatile, so the settings page may edit it");
ok(mod.Config.dict.webhookUrl?.meta?.role === "secret", "webhookUrl is a secret, so no view echoes it");
ok(mod.Config.dict.secret?.meta?.role === "secret", "secret is a secret");
ok(Object.values(mod.Config.dict).every((field) => field.meta?.volatile === true),
  "every field is volatile, so none of the configuration is invisible to the settings page");

process.stdout.write("\n2. tool push\n");
const toolTitle = "Investigate the flaky deploy";
const toolSession = fakeSession([{ type: "session/title", data: { title: toolTitle } }]);
const toolExec = { agent: { session: toolSession }, callId: "call-tool-1", signal: undefined };

const beforeTool = webhook.received.length;
const disabledResult = await tool.execute({ message: "hello", kind: "progress" }, toolExec).then(
  () => undefined,
  (error) => String(error?.message ?? error)
);
contains(disabledResult, "no webhookUrl configured", "tool throws while the webhook is unconfigured");
ok(webhook.received.length === beforeTool, "no request was sent while unconfigured");

await ctx.settings.update("dsh-feishu-beacon", { webhookUrl: BEACON_URL, maxChars: 1800 });
const toolResult = await resolve().execute({
  message: "Step 1 of 4 done: reproduced the flake.",
  kind: "progress",
  watch: true
}, toolExec);
ok(webhook.received.length === beforeTool + 1, "tool push reached the webhook");
equal(toolResult, { kind: "progress", delivered: true }, "tool output value");
const toolText = payloadTextRaw(webhook.received.at(-1));
equal(toolText.split("\n")[0], "PROGRESS", "the first line is the kind label alone");
ok(!toolText.includes("dsh-feishu-beacon"), "the pushed message never repeats the package name");
contains(toolText, `Task: ${toolTitle}`, "tool message carries the session title");
contains(toolText, "Workspace: beacon-workspace", "tool message carries the workspace title");
ok(/Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(toolText), "tool message carries a local timestamp",
  toolText.split("\n").slice(0, 5).join(" | "));
contains(toolText, "Step 1 of 4 done: reproduced the flake.", "tool message carries the model text");
equal(payloadOf(webhook.received.at(-1)).msg_type, "interactive", "the default format is an interactive card");
ok(isCard(webhook.received.at(-1)), "the payload carries a card object");
equal(templateOf(webhook.received.at(-1)), "blue", "a progress milestone uses the blue header");
equal(payloadOf(webhook.received.at(-1)).card?.header?.title?.tag, "plain_text",
  "the card title is plain text, so nothing in it is interpreted as markup");
ok((payloadOf(webhook.received.at(-1)).card?.elements ?? []).some((element) => element.tag === "hr"),
  "the card separates its metadata from the body with a rule");
ok((payloadOf(webhook.received.at(-1)).card?.elements ?? [])
  .filter((element) => element.tag === "div")
  .every((element) => element.text?.tag === "lark_md"),
"every text block is markdown, so the body keeps its emphasis");

const renderText = tool.output.render({}, { kind: "done" })[0].text;
equal(renderText, "Pushed (done)", "tool output render text");

process.stdout.write("\n3. ask_user_question push\n");
process.stdout.write("\n3. silent until watched, then ask_user_question push\n");
const questionSession = fakeSession([{ type: "session/title", data: { title: "Choose a storage engine" } }]);
const questionCall = {
  type: "tool/call",
  data: {
    name: "ask_user_question",
    callId: "call-question-1",
    arguments: JSON.stringify({
      questions: [
        {
          id: "engine",
          header: "Storage",
          question: "Which storage engine should the beacon use?",
          options: [
            { label: "SQLite (Recommended)", description: "No extra service to run." },
            { label: "Postgres", description: "Needs a server and a migration path." }
          ]
        },
        {
          id: "channels",
          header: "Channels",
          question: "Which channels should be notified?",
          multi_select: true,
          options: [
            { label: "Feishu", description: "The only transport implemented." },
            { label: "Email", description: "Not implemented yet." }
          ]
        }
      ]
    })
  }
};
const beforeQuestion = webhook.received.length;
emit(state, questionSession, questionCall);
await settle(40);
equal(webhook.received.length, beforeQuestion, "an unwatched session pushes nothing at all");
await watchSession(state, questionSession);
emit(state, questionSession, questionCall);
ok(await until(() => webhook.received.length === beforeQuestion + 1, "question push"), "question event pushed once watched");
const questionText = payloadTextRaw(webhook.received.at(-1));
contains(questionText, "Answer needed", "question title");
contains(questionText, "Which storage engine should the beacon use?", "question body");
contains(questionText, "Storage: ", "question header");
contains(questionText, "SQLite (Recommended)", "first option label");
contains(questionText, "No extra service to run.", "first option description");
contains(questionText, "Needs a server and a migration path.", "second option description");
contains(questionText, "[multi-select]", "multi-select marker");
contains(questionText, "Email", "second question option");
contains(questionText, "Back to your computer to handle this.", "question footer");

process.stdout.write("\n4. callId dedupe\n");
const beforeDuplicate = webhook.received.length;
emit(state, questionSession, questionCall);
await settle(40);
ok(webhook.received.length === beforeDuplicate, "the same callId never pushes twice");

process.stdout.write("\n5. approval push\n");
const approvalSession = fakeSession([{ type: "session/title", data: { title: "Deploy to staging" } }]);
await watchSession(state, approvalSession);
const beforeApproval = webhook.received.length;
emit(state, approvalSession, {
  type: "approval/asked",
  data: { id: "approval-1", toolName: "pwsh", callId: "call-approval-1", reason: "The command writes outside the workspace." }
});
ok(await until(() => webhook.received.length === beforeApproval + 1, "approval push"), "approval event pushed");
const approvalText = payloadTextRaw(webhook.received.at(-1));
contains(approvalText, "Authorization needed", "approval title");
contains(approvalText, "tool: pwsh", "approval tool name");
contains(approvalText, "reason: The command writes outside the workspace.", "approval reason");

process.stdout.write("\n6. failed turn push\n");
const errorSession = fakeSession([{ type: "session/title", data: { title: "Migrate the schema" } }]);
await watchSession(state, errorSession);
const beforeError = webhook.received.length;
emit(state, errorSession, {
  type: "turn/end",
  time: "2026-01-01T00:00:01.000Z",
  data: { turn: 3, reason: { kind: "error", error: { message: "Provider returned 429", code: "RATE_LIMIT" } } }
});
ok(await until(() => webhook.received.length === beforeError + 1, "error push"), "failed turn pushed");
const errorText = payloadTextRaw(webhook.received.at(-1));
contains(errorText, "Turn failed", "error title");
contains(errorText, "Provider returned 429", "error message");
contains(errorText, "(RATE_LIMIT)", "error code");
// The watch ends with the turn that carried it. Checking after the error push is
// the point: a close that ran first would have swallowed the failure the user
// stepped away from.
ok(errorSession.events.some((event) => event.type === "beacon/unwatch"),
  "the failed turn closed the watch, after pushing");
const watchEventsBeforeCompleted = errorSession.appended.filter((event) => event.type === "beacon/unwatch").length;

process.stdout.write("\n7. completed turn stays silent\n");
const beforeCompleted = webhook.received.length;
emit(state, errorSession, {
  type: "turn/end",
  time: "2026-01-01T00:00:02.000Z",
  data: { turn: 4, reason: { kind: "completed" } }
});
emit(state, errorSession, {
  type: "turn/end",
  time: "2026-01-01T00:00:03.000Z",
  data: { turn: 5, reason: { kind: "aborted", reason: { kind: "user" } } }
});
await settle(40);
ok(webhook.received.length === beforeCompleted, "completed and aborted turns push nothing");
equal(errorSession.appended.filter((event) => event.type === "beacon/unwatch").length, watchEventsBeforeCompleted,
  "an already-closed watch is not closed twice");

process.stdout.write("\n7b. the watch lifecycle\n");
// Silent by default: a fresh session with no watch pushes nothing, whatever the
// switches say. This is the behaviour the whole feature exists for.
const quietSession = fakeSession([{ type: "session/title", data: { title: "Unwatched" } }]);
const beforeQuiet = webhook.received.length;
emit(state, quietSession, {
  type: "approval/asked",
  data: { id: "approval-quiet", toolName: "pwsh", callId: "call-quiet", reason: "unwatched" }
});
emit(state, quietSession, {
  type: "turn/end",
  time: "2026-01-01T00:00:08.000Z",
  data: { turn: 9, reason: { kind: "error", error: { message: "unwatched failure", code: "X" } } }
});
await settle(40);
equal(webhook.received.length, beforeQuiet, "an unwatched session pushes nothing, approvals and failures included");

// The tool can open a watch — that is how prose becomes a decision.
const openedSession = fakeSession([{ type: "session/title", data: { title: "Opened by the tool" } }]);
const openedExec = { agent: { session: openedSession }, callId: "call-open", signal: undefined };
const beforeOpen = webhook.received.length;
const refusedWithoutWatch = await state.tools.get("dsh_beacon")
  .execute({ message: "nobody asked for this" }, openedExec)
  .then(() => undefined, (error) => String(error?.message ?? error));
contains(refusedWithoutWatch, "not watching this session", "an unwatched tool call says why it refused");
equal(webhook.received.length, beforeOpen, "the refused tool call pushed nothing");
const openedResult = await state.tools.get("dsh_beacon")
  .execute({ message: "plan: four steps", kind: "plan", watch: true }, openedExec);
equal(openedResult, { kind: "plan", delivered: true }, "watch:true opens the watch and pushes the first message");
equal(webhook.received.length, beforeOpen + 1, "the opening message was pushed");
ok(openedSession.events.some((event) => event.type === "beacon/watch"), "the watch was recorded on the session");

// And once open, the event layer reports too.
const beforeOpenedEvent = webhook.received.length;
emit(state, openedSession, {
  type: "approval/asked",
  data: { id: "approval-open", toolName: "pwsh", callId: "call-open-2", reason: "watched" }
});
ok(await until(() => webhook.received.length === beforeOpenedEvent + 1, "watched approval"),
  "a watched session pushes approvals");

// A decision does not end the turn, so the watch survives it: the model parks on
// the user rather than handing control back.
const beforeDecision = webhook.received.length;
await state.tools.get("dsh_beacon").execute({ message: "which way?", kind: "decision" }, openedExec);
equal(webhook.received.length, beforeDecision + 1, "a decision milestone is pushed while watching");
ok(openedSession.events.filter((event) => event.type === "beacon/unwatch").length === 0,
  "a decision leaves the watch open, because the turn is still running");

// The turn ending is what closes it.
emit(state, openedSession, {
  type: "turn/end",
  time: "2026-01-01T00:00:20.000Z",
  data: { turn: 11, reason: { kind: "completed" } }
});
await settle(20);
ok(openedSession.events.some((event) => event.type === "beacon/unwatch"),
  "the completed turn closed the watch");
const beforeAfterClose = webhook.received.length;
emit(state, openedSession, {
  type: "approval/asked",
  data: { id: "approval-after", toolName: "pwsh", callId: "call-after", reason: "after" }
});
await settle(40);
equal(webhook.received.length, beforeAfterClose, "the closed watch stops the event layer again");

process.stdout.write("\n8. signing\n");
const signedTool = await edit({ secret: SECRET });
const beforeSign = webhook.received.length;
await signedTool.execute({ message: "signed push", kind: "decision", watch: true }, toolExec);
const signed = webhook.received.at(-1);
ok(signed !== undefined && webhook.received.length === beforeSign + 1, "signed push reached the webhook");
const signedUrl = new URL(`http://127.0.0.1${signed.url}`);
const timestamp = signedUrl.searchParams.get("timestamp");
const sign = signedUrl.searchParams.get("sign");
ok(timestamp !== null && /^\d+$/.test(timestamp), "request URL carries a second-precision timestamp", signed.url);
ok(sign !== null && sign.length > 0, "request URL carries a sign parameter", signed.url);
const expectedSign = createHmac("sha256", `${timestamp}\n${SECRET}`).update("").digest("base64");
equal(sign, expectedSign, "signature equals an independently computed feishuSign");
equal(mod.__testing.feishuSign(timestamp, SECRET), expectedSign, "exported feishuSign matches the independent computation");

process.stdout.write("\n9. unconfigured webhook throws\n");
await edit({ webhookUrl: "" });
const unconfigured = await mod.__testing.sendFeishu("", "x").then(() => undefined, (error) => String(error?.message ?? error));
ok(unconfigured !== undefined, "an empty webhook URL cannot deliver");

process.stdout.write("\n10. hot configuration overrides\n");
await edit({ webhookUrl: BEACON_URL, secret: "" });
const beforeOff = webhook.received.length;
const offTool = await edit({ notifyQuestion: false });
ok(offTool === state.tools.get("dsh_beacon"), "a settings edit re-applies the row");
ok(state.resolved.notifyQuestion.get() === false, "the re-applied row holds the edited value");
emit(state, questionSession, {
  type: "tool/call",
  data: { name: "ask_user_question", callId: "call-question-2", arguments: JSON.stringify({ questions: [{ id: "q", question: "Off?" }] }) }
});
await settle(40);
ok(webhook.received.length === beforeOff, "notifyQuestion:false suppresses question pushes without a restart");
await edit({ notifyQuestion: true });
emit(state, questionSession, {
  type: "tool/call",
  data: { name: "ask_user_question", callId: "call-question-3", arguments: JSON.stringify({ questions: [{ id: "q", question: "Back on?" }] }) }
});
ok(await until(() => webhook.received.length === beforeOff + 1, "question push after re-enable"), "re-enabling restores question pushes");

await edit({ notifyApproval: false });
const beforeApprovalOff = webhook.received.length;
emit(state, approvalSession, {
  type: "approval/asked",
  data: { id: "approval-2", toolName: "pwsh", callId: "call-approval-2", reason: "off" }
});
await settle(30);
ok(webhook.received.length === beforeApprovalOff, "notifyApproval:false suppresses approval pushes");
await edit({ notifyApproval: true });

await edit({ notifyError: false });
const beforeErrorOff = webhook.received.length;
emit(state, errorSession, {
  type: "turn/end",
  time: "2026-01-01T00:00:09.000Z",
  data: { turn: 6, reason: { kind: "error", error: { message: "off", code: "X" } } }
});
await settle(30);
ok(webhook.received.length === beforeErrorOff, "notifyError:false suppresses failed-turn pushes");
await edit({ notifyError: true });

const disabledSwitchTool = await edit({ enabled: false });
const disabledTool = await disabledSwitchTool.execute({ message: "should not pass" }, toolExec).then(
  () => undefined,
  (error) => String(error?.message ?? error)
);
contains(disabledTool, "disabled", "the enabled:false master switch makes the tool throw");
await edit({ enabled: true });

process.stdout.write("\n11. test route\n");
await edit({ webhookUrl: BEACON_URL, prefix: "" });
const testOk = await callRoute(state, TEST_PATH, "POST", {});
equal(testOk.status, 200, "test route returns 200 with a configured webhook");
contains(testOk.json?.message ?? "", "Test message sent", "test route success message");
const testText = payloadTextRaw(webhook.received.at(-1));
contains(testText, "TEST", "test message carries the TEST title");
equal(testText.split("\n")[0], "TEST", "the test message's first line is its title alone, with no prefix set");
ok(!testText.split("\n")[0].includes("dsh-feishu-beacon"), "the test message's title never repeats the package name");
ok(!testText.includes("Task:"), "the test message carries no task: it belongs to no session");
ok(!testText.includes("Workspace:"), "the test message carries no workspace");
equal(templateOf(webhook.received.at(-1)), "grey", "the delivery check uses its own header colour");

// The prefix is documented as prepended to every pushed title, so the delivery
// check must carry it too.
const prefixed = await edit({ prefix: "HOME-PC" });
ok(prefixed !== undefined, "the prefix edit applied");
await callRoute(state, TEST_PATH, "POST", {});
equal(payloadTextRaw(webhook.received.at(-1)).split("\n")[0], "HOME-PC TEST",
  "a configured prefix is prepended to the test message's title");
contains(payloadTextRaw(webhook.received.at(-1)), "Time: ",
  "the test message carries a timestamp");
await edit({ prefix: "" });

const testOverride = await callRoute(state, TEST_PATH, "POST", { message: "one-off check" });
equal(testOverride.status, 200, "test route accepts an explicit message");
contains(payloadTextRaw(webhook.received.at(-1)), "one-off check", "test route sends the supplied message");

const longMessage = "x".repeat(4000);
await callRoute(state, TEST_PATH, "POST", { message: longMessage });
const longText = payloadTextRaw(webhook.received.at(-1));
ok(longText.length <= 1800, "the test message obeys the same length budget as a milestone",
  `${String(longText.length)} characters`);
ok(longText.endsWith("..."), "an over-budget test message is truncated with an ellipsis");

const testWrongMethod = await callRoute(state, TEST_PATH, "GET");
equal(testWrongMethod.status, 405, "test route rejects GET");

process.stdout.write("\n12. config route\n");
const getView = await callRoute(state, CONFIG_PATH, "GET");
equal(getView.status, 200, "GET config returns 200");
ok(getView.json !== undefined, "GET config returns JSON");
ok(!getView.raw.includes(BEACON_URL), "GET config never echoes webhookUrl");
ok(!getView.raw.includes(SECRET), "GET config never echoes secret");
ok(!Object.hasOwn(getView.json ?? {}, "webhookUrl"), "GET config has no webhookUrl key");
ok(!Object.hasOwn(getView.json ?? {}, "secret"), "GET config has no secret key");
equal(getView.json?.webhookConfigured, true, "GET config reports webhookConfigured");
equal(getView.json?.secretConfigured, false, "GET config reports secretConfigured");
equal(getView.json?.notifyError, true, "GET config reports event switches");

const plainPost = await callRoute(state, CONFIG_PATH, "POST", { webhookUrl: "http://insecure.example/hook" });
equal(plainPost.status, 400, "POST of a non-https webhook returns 400");

const stored = await callRoute(state, CONFIG_PATH, "POST", { webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/second", secret: "second-secret" });
equal(stored.status, 200, "POST of a valid https webhook returns 200");
equal(state.config.webhookUrl, "https://open.feishu.cn/open-apis/bot/v2/hook/second", "POST wrote through the settings service");
equal(state.config.secret, "second-secret", "POST wrote the secret through the settings service");
const storedWrite = state.writes.at(-1);
equal(storedWrite?.ns, "dsh-feishu-beacon", "the write names the plugin's settings entry");
equal(storedWrite?.kind, "update", "a plain value travels as a settings update");
ok(!JSON.stringify(stored.json).includes("second-secret"), "POST response does not echo the secret");
ok(!JSON.stringify(stored.json).includes("hook/second"), "POST response does not echo the webhook");

const blanked = await callRoute(state, CONFIG_PATH, "POST", { webhookUrl: "", secret: "", prefix: "ci" });
equal(blanked.status, 200, "POST with blank credentials returns 200");
equal(state.config.webhookUrl, "https://open.feishu.cn/open-apis/bot/v2/hook/second", "blank webhookUrl keeps the stored value");
equal(state.config.secret, "second-secret", "blank secret keeps the stored value");
equal(state.config.prefix, "ci", "non-secret fields still update");

const toggles = await callRoute(state, CONFIG_PATH, "POST", { notifyQuestion: false, maxChars: 900 });
equal(toggles.status, 200, "POST of switches returns 200");
equal(state.config.notifyQuestion, false, "POST updates notifyQuestion");
equal(state.config.maxChars, 900, "POST updates maxChars");
await callRoute(state, CONFIG_PATH, "POST", { notifyQuestion: true, maxChars: 1800 });

const malformed = await callRoute(state, CONFIG_PATH, "POST", "{not json");
equal(malformed.status, 400, "malformed JSON returns 400");
const wrongMethod = await callRoute(state, CONFIG_PATH, "DELETE");
equal(wrongMethod.status, 405, "unsupported method returns 405");

process.stdout.write("\n13. cleared credentials\n");
const cleared = await callRoute(state, CONFIG_PATH, "POST", { clearWebhook: true, clearSecret: true });
equal(cleared.status, 200, "clearWebhook returns 200");
ok(!Object.hasOwn(state.config, "webhookUrl"), "clearWebhook unsets the stored webhook");
ok(!Object.hasOwn(state.config, "secret"), "clearSecret unsets the stored secret");
const clearWrite = state.writes.at(-1);
equal(clearWrite?.kind, "mutate", "a clear travels as a declarative mutate, not an empty string");
equal(clearWrite?.ops, [{ op: "unset", path: ["webhookUrl"] }, { op: "unset", path: ["secret"] }], "the clear unsets both credential paths");

// The runtime re-applies the row as part of finishing the write. The route
// answers from the resolved configuration it publishes on each apply, so the
// next request describes the cleared state; this re-apply is that step.
await edit({});
const afterClearView = await callRoute(state, CONFIG_PATH, "GET");
equal(afterClearView.json?.webhookConfigured, false, "the cleared webhook is absent from the view");
equal(afterClearView.json?.secretConfigured, false, "the cleared secret is absent from the view");

const testAfterClear = await callRoute(state, TEST_PATH, "POST", {});
equal(testAfterClear.status, 502, "test route returns 502 once the webhook is cleared");

process.stdout.write("\n14. card fallback and explicit text format\n");
// A group that refuses interactive cards must not cost the user the message:
// arriving plainly is the point, arriving prettily is the bonus.
await edit({ webhookUrl: BEACON_URL, format: "card" });
webhook.refuseCards(true);
const beforeFallback = webhook.received.length;
const fallbackTool = await edit({});
const fallbackResult = await fallbackTool.execute({ message: "must still arrive", kind: "progress", watch: true }, toolExec).then(
  (value) => value,
  (error) => String(error?.message ?? error)
);
const fallbackSends = webhook.received.slice(beforeFallback);
equal(fallbackSends.length, 2, "a refused card is followed by the same message as text");
equal(isCard(fallbackSends[0]), true, "the first attempt is the card");
equal(payloadOf(fallbackSends[1]).msg_type, "text", "the second attempt is plain text");
contains(payloadOf(fallbackSends[1]).content?.text ?? "", "must still arrive", "the fallback carries the body");
equal(fallbackResult, { kind: "progress", delivered: true }, "the tool reports success once the text lands");
ok(state.logs.some(([level, message]) => level === "warn" && message.includes("card was refused")),
  "a refused card is reported, not swallowed silently");

// The delivery check reports the same thing, so the settings page can say the
// group will never show a card.
const fallbackTest = await callRoute(state, TEST_PATH, "POST", {});
equal(fallbackTest.status, 200, "the test route still succeeds through the fallback");
equal(fallbackTest.json?.cardAccepted, false, "the test route reports that the card was refused");
contains(fallbackTest.json?.message ?? "", "did not accept an interactive card", "the page is told why the message is plain");
webhook.refuseCards(false);

// An explicit text format skips the card entirely — one request, not two.
await edit({ format: "text" });
const beforeText = webhook.received.length;
const textTool = await edit({});
await textTool.execute({ message: "no card at all", kind: "progress", watch: true }, toolExec);
const textSends = webhook.received.slice(beforeText);
equal(textSends.length, 1, "the text format sends once, with no card to refuse");
equal(payloadOf(textSends[0]).msg_type, "text", "the text format is plain text");
await edit({ format: "card" });

process.stdout.write("\n15. the /beacon command\n");
await edit({ webhookUrl: BEACON_URL, prefix: "", enabled: true });

/** Invoke the registered command the way the command runtime would. */
const runBeacon = (rawInput) => state.commands.get("beacon").handler({
  rawInput,
  agent: { session: toolSession },
  signal: undefined,
  attachments: []
});

const commandDef = state.commands.get("beacon");
equal(commandDef.name, "beacon", "the command is named beacon, so it is invoked as /beacon");
ok(typeof commandDef.description === "string" && commandDef.description.length > 0,
  "the command advertises a description for discovery");
equal(commandDef.input?.hint, "on / off / status / clear, or a message to push", "the command advertises an input hint");

const noArgs = await runBeacon("");
equal(noArgs.kind, "success", "an empty invocation answers rather than failing");
contains(noArgs.text, "/beacon clear", "the empty invocation shows how the subcommands are spelled");

const statusResult = await runBeacon("status");
equal(statusResult.kind, "success", "status succeeds");
contains(statusResult.text, "webhook: configured", "status reports the stored webhook");
contains(statusResult.text, "format: card", "status reports the format");
contains(statusResult.text, "questions on, approvals on, failures on", "status reports the switches");

const beforeCommand = webhook.received.length;
const pushed = await runBeacon("deploy is green");
equal(pushed.kind, "success", "a message invocation succeeds");
contains(pushed.text, "Pushed to Feishu", "the reply confirms delivery");
equal(webhook.received.length, beforeCommand + 1, "the command pushed exactly one message");
const commandText = payloadTextRaw(webhook.received.at(-1));
contains(commandText, "deploy is green", "the pushed message carries the text after the command name");
contains(commandText, "PROGRESS", "the command pushes as a progress milestone");
contains(commandText, `Task: ${toolTitle}`, "the command push carries the session it came from");
equal(isCard(webhook.received.at(-1)), true, "the command pushes through the normal format, not a side path");

// A near-miss on a subcommand is a typo, and pushing it would spend a real
// notification on the user's own mistake.
const beforeTypo = webhook.received.length;
const typo = await runBeacon("cleer");
equal(typo.kind, "success", "an unknown single word is treated as a message, not an error");
equal(webhook.received.length, beforeTypo + 1, "that word was pushed as a message");
const nearMiss = await runBeacon("clear now please");
equal(nearMiss.kind, "error", "a known subcommand with trailing text is refused");
contains(nearMiss.text, "Unknown subcommand", "the refusal explains itself");
equal(webhook.received.length, beforeTypo + 1, "the refusal pushed nothing");

// Disabled is disabled, whichever entry point asks.
await edit({ enabled: false });
const disabledCommand = await runBeacon("should not go");
equal(disabledCommand.kind, "error", "the command refuses while the master switch is off");
contains(disabledCommand.text, "disabled", "the refusal names the switch");
await edit({ enabled: true });

process.stdout.write("\n16. the /beacon clear subcommand\n");
const clearResult = await runBeacon("clear");
equal(clearResult.kind, "success", "clear succeeds");
contains(clearResult.text, "Cleared the stored webhook", "clear reports what it did");
ok(!Object.hasOwn(state.config, "webhookUrl"), "clear unsets the stored webhook");
ok(!Object.hasOwn(state.config, "secret"), "clear unsets the stored secret");
const clearCommandWrite = state.writes.at(-1);
equal(clearCommandWrite?.kind, "mutate", "clear travels as a declarative unset");
equal(clearCommandWrite?.ops, [{ op: "unset", path: ["webhookUrl"] }, { op: "unset", path: ["secret"] }],
  "clear unsets both credential paths");

// A command that edits configuration rewrites the stored patch, exactly as the
// settings route does, so the row has to be re-resolved before the next push —
// that re-resolution is what publishes the new config to the plugin.
await edit({});
const pushWithoutWebhook = await runBeacon("after clear");
equal(pushWithoutWebhook.kind, "error", "pushing without a webhook fails");
contains(pushWithoutWebhook.text, "no webhookUrl configured", "the failure says what to set");
await edit({ webhookUrl: BEACON_URL });

process.stdout.write("\n17. teardown\n");
// Re-apply so the disposers under test belong to the row currently mounted.
await edit({});
const disposers = state.disposers ?? [];
ok(disposers.length >= 3, "routes and the command are registered through effects", String(disposers.length));
ok(state.routes.size === 2, "the newly mounted row has both routes", String(state.routes.size));
ok(state.commands.has("beacon"), "the newly mounted row has the command");
for (const dispose of disposers) dispose();
ok(state.routes.size === 0, "the effect disposers unmount the routes", `still mounted: ${[...state.routes.keys()].join(", ")}`);
ok(!state.commands.has("beacon"), "the effect disposer unregisters the command");
await edit({});
ok(state.routes.size === 2, "re-applying after teardown mounts them again", String(state.routes.size));

process.stdout.write("\n18. error containment\n");
ok(state.logs.every(([level]) => level !== "error"), "event pushes never logged at error level");

webhook.received.length = 0;
await webhook.close();

process.stdout.write(`\n${String(checks - failures)}/${String(checks)} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${String(failures)} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("smoke: PASS\n");
