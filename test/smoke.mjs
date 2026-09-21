/**
 * Host-half smoke test for dsh-feishu-beacon.
 *
 * No real DSH host and no real network: a local http server impersonates the
 * Feishu webhook and records what it receives, and a hand-built fake context
 * drives `apply`.
 *
 * On the settings stub: the route handlers close over the scope that `apply`
 * created, so every configuration assertion reads THAT scope, captured from the
 * `settings.register` stub. Asserting against a scope built by the test would
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

/** Build a fake context and the settings scope that `apply` will register. */
function makeCtx(base) {
  const state = {
    tools: new Map(),
    listeners: new Map(),
    routes: new Map(),
    effects: [],
    logs: [],
    scope: undefined,
    registrations: []
  };
  const settingsSection = {};
  const ctx = {
    tools: {
      register(tool) {
        state.tools.set(tool.name, tool);
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
      register(ns, schema, options) {
        state.registrations.push({ ns, schema, options });
        const scope = {
          get: () => ({ ...options.base, ...settingsSection }),
          update: async (patch) => {
            Object.assign(settingsSection, patch);
          },
          replace: async (section) => {
            for (const key of Object.keys(settingsSection)) delete settingsSection[key];
            Object.assign(settingsSection, section);
          },
          watch: () => () => {}
        };
        state.scope = scope;
        return scope;
      }
    },
    effect(fn) {
      state.effects.push(fn);
    },
    webServer: {
      register(route) {
        state.routes.set(route.path, route);
        return () => state.routes.delete(route.path);
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

/** Install the two effect-registered routes, the way the loader would. */
function mountRoutes(state) {
  for (const effect of state.effects) effect();
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

/** A session stub shaped like the documented `session/event` callback argument. */
function fakeSession(events) {
  return {
    id: "session-1",
    header: { cwd: WORKSPACE_CWD },
    events
  };
}

/* ------------------------------------------------------------------ the mock */

/** A local Feishu stand-in that records every request it receives. */
async function startWebhook() {
  const received = [];
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

/** Emit one session event into every registered hook. */
function emit(state, session, event) {
  for (const listener of state.listeners.get("session/event") ?? []) listener(session, event);
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
    "The host imports resolve through a per-checkout junction:",
    "",
    "  New-Item -ItemType Junction -Path node_modules\\@deepseek-ai -Target \"$env:USERPROFILE\\.dsh\\profiles\\node_modules\\@deepseek-ai\"",
    "",
    `underlying error: ${String(error?.message ?? error)}`,
    ""
  ].join("\n"));
  await webhook.close();
  process.exit(1);
}

const BEACON_URL = `${webhook.origin}/open-apis/bot/v2/hook/beacon`;
const SECRET = "beacon-signing-secret";
const CONFIG_PATH = "/api/dsh-feishu-beacon/config";
const TEST_PATH = "/api/dsh-feishu-beacon/test";

process.stdout.write("\n1. registration\n");
mod.apply(ctx, base);
mountRoutes(state);
ok(state.tools.has("dsh_beacon"), "registers the dsh_beacon tool");
ok((state.listeners.get("session/event") ?? []).length === 1, "hooks session/event once");
ok(state.routes.size === 2, "registers exactly 2 routes", `registered: ${[...state.routes.keys()].join(", ")}`);
ok(state.registrations.length === 1 && state.registrations[0].ns === "dsh-feishu-beacon",
  "registers the dsh-feishu-beacon settings namespace");
ok(state.scope !== undefined, "captured the scope apply itself uses");
equal(mod.inject, ["tools", "workspaceRegistry", "settings", "webServer"], "inject list");
ok(mod.name === "dsh-feishu-beacon", "plugin name");

process.stdout.write("\n2. tool push\n");
const tool = state.tools.get("dsh_beacon");
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

await state.scope.update({ webhookUrl: BEACON_URL, maxChars: 1800 });
const toolResult = await tool.execute({ message: "Step 1 of 4 done: reproduced the flake.", kind: "progress" }, toolExec);
ok(webhook.received.length === beforeTool + 1, "tool push reached the webhook");
equal(toolResult, { kind: "progress", delivered: true }, "tool output value");
const toolText = webhook.received.at(-1).json.content.text;
contains(toolText, "PROGRESS", "tool message carries the kind label");
contains(toolText, `Task: ${toolTitle}`, "tool message carries the session title");
contains(toolText, "Workspace: beacon-workspace", "tool message carries the workspace title");
ok(/Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(toolText), "tool message carries a local timestamp",
  toolText.split("\n").slice(0, 5).join(" | "));
contains(toolText, "Step 1 of 4 done: reproduced the flake.", "tool message carries the model text");
equal(webhook.received.at(-1).json.msg_type, "text", "Feishu envelope msg_type");
ok(typeof webhook.received.at(-1).json.content?.text === "string", "Feishu envelope content.text");

const renderText = tool.output.render({}, { kind: "done" })[0].text;
equal(renderText, "Pushed (done)", "tool output render text");

process.stdout.write("\n3. ask_user_question push\n");
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
ok(await until(() => webhook.received.length === beforeQuestion + 1, "question push"), "question event pushed");
const questionText = webhook.received.at(-1).json.content.text;
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
const beforeApproval = webhook.received.length;
emit(state, approvalSession, {
  type: "approval/asked",
  data: { id: "approval-1", toolName: "pwsh", callId: "call-approval-1", reason: "The command writes outside the workspace." }
});
ok(await until(() => webhook.received.length === beforeApproval + 1, "approval push"), "approval event pushed");
const approvalText = webhook.received.at(-1).json.content.text;
contains(approvalText, "Authorization needed", "approval title");
contains(approvalText, "tool: pwsh", "approval tool name");
contains(approvalText, "reason: The command writes outside the workspace.", "approval reason");

process.stdout.write("\n6. failed turn push\n");
const errorSession = fakeSession([{ type: "session/title", data: { title: "Migrate the schema" } }]);
const beforeError = webhook.received.length;
emit(state, errorSession, {
  type: "turn/end",
  time: "2026-01-01T00:00:01.000Z",
  data: { turn: 3, reason: { kind: "error", error: { message: "Provider returned 429", code: "RATE_LIMIT" } } }
});
ok(await until(() => webhook.received.length === beforeError + 1, "error push"), "failed turn pushed");
const errorText = webhook.received.at(-1).json.content.text;
contains(errorText, "Turn failed", "error title");
contains(errorText, "Provider returned 429", "error message");
contains(errorText, "(RATE_LIMIT)", "error code");

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

process.stdout.write("\n8. signing\n");
await state.scope.update({ secret: SECRET });
const beforeSign = webhook.received.length;
await tool.execute({ message: "signed push", kind: "decision" }, toolExec);
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
await state.scope.update({ webhookUrl: "" });
const unconfigured = await mod.__testing.sendFeishu("", "x").then(() => undefined, (error) => String(error?.message ?? error));
ok(unconfigured !== undefined, "an empty webhook URL cannot deliver");

process.stdout.write("\n10. hot configuration overrides\n");
await state.scope.update({ webhookUrl: BEACON_URL, secret: "" });
const beforeOff = webhook.received.length;
await state.scope.update({ notifyQuestion: false });
ok(state.scope.get().notifyQuestion === false, "scope.get reflects the update (the plugin reads this live)");
emit(state, questionSession, {
  type: "tool/call",
  data: { name: "ask_user_question", callId: "call-question-2", arguments: JSON.stringify({ questions: [{ id: "q", question: "Off?" }] }) }
});
await settle(40);
ok(webhook.received.length === beforeOff, "notifyQuestion:false suppresses question pushes without a restart");
await state.scope.update({ notifyQuestion: true });
emit(state, questionSession, {
  type: "tool/call",
  data: { name: "ask_user_question", callId: "call-question-3", arguments: JSON.stringify({ questions: [{ id: "q", question: "Back on?" }] }) }
});
ok(await until(() => webhook.received.length === beforeOff + 1, "question push after re-enable"), "re-enabling restores question pushes");

await state.scope.update({ notifyApproval: false });
const beforeApprovalOff = webhook.received.length;
emit(state, approvalSession, {
  type: "approval/asked",
  data: { id: "approval-2", toolName: "pwsh", callId: "call-approval-2", reason: "off" }
});
await settle(30);
ok(webhook.received.length === beforeApprovalOff, "notifyApproval:false suppresses approval pushes");
await state.scope.update({ notifyApproval: true });

await state.scope.update({ notifyError: false });
const beforeErrorOff = webhook.received.length;
emit(state, errorSession, {
  type: "turn/end",
  time: "2026-01-01T00:00:09.000Z",
  data: { turn: 6, reason: { kind: "error", error: { message: "off", code: "X" } } }
});
await settle(30);
ok(webhook.received.length === beforeErrorOff, "notifyError:false suppresses failed-turn pushes");
await state.scope.update({ notifyError: true });

await state.scope.update({ enabled: false });
const disabledTool = await tool.execute({ message: "should not pass" }, toolExec).then(
  () => undefined,
  (error) => String(error?.message ?? error)
);
contains(disabledTool, "disabled", "the enabled:false master switch makes the tool throw");
await state.scope.update({ enabled: true });

process.stdout.write("\n11. test route\n");
await state.scope.update({ webhookUrl: BEACON_URL });
const testOk = await callRoute(state, TEST_PATH, "POST", {});
equal(testOk.status, 200, "test route returns 200 with a configured webhook");
contains(testOk.json?.message ?? "", "Test message sent", "test route success message");
contains(webhook.received.at(-1)?.json?.content?.text ?? "", "TEST", "test message carries the TEST title");

const testOverride = await callRoute(state, TEST_PATH, "POST", { message: "one-off check" });
equal(testOverride.status, 200, "test route accepts an explicit message");
contains(webhook.received.at(-1)?.json?.content?.text ?? "", "one-off check", "test route sends the supplied message");

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
equal(state.scope.get().webhookUrl, "https://open.feishu.cn/open-apis/bot/v2/hook/second", "POST wrote through the scope apply owns");
equal(state.scope.get().secret, "second-secret", "POST wrote the secret through the scope apply owns");
ok(!JSON.stringify(stored.json).includes("second-secret"), "POST response does not echo the secret");
ok(!JSON.stringify(stored.json).includes("hook/second"), "POST response does not echo the webhook");

const blanked = await callRoute(state, CONFIG_PATH, "POST", { webhookUrl: "", secret: "", prefix: "ci" });
equal(blanked.status, 200, "POST with blank credentials returns 200");
equal(state.scope.get().webhookUrl, "https://open.feishu.cn/open-apis/bot/v2/hook/second", "blank webhookUrl keeps the stored value");
equal(state.scope.get().secret, "second-secret", "blank secret keeps the stored value");
equal(state.scope.get().prefix, "ci", "non-secret fields still update");

const toggles = await callRoute(state, CONFIG_PATH, "POST", { notifyQuestion: false, maxChars: 900 });
equal(toggles.status, 200, "POST of switches returns 200");
equal(state.scope.get().notifyQuestion, false, "POST updates notifyQuestion");
equal(state.scope.get().maxChars, 900, "POST updates maxChars");
await callRoute(state, CONFIG_PATH, "POST", { notifyQuestion: true, maxChars: 1800 });

const malformed = await callRoute(state, CONFIG_PATH, "POST", "{not json");
equal(malformed.status, 400, "malformed JSON returns 400");
const wrongMethod = await callRoute(state, CONFIG_PATH, "DELETE");
equal(wrongMethod.status, 405, "unsupported method returns 405");

process.stdout.write("\n13. cleared webhook\n");
const cleared = await callRoute(state, CONFIG_PATH, "POST", { clearWebhook: true });
equal(cleared.status, 200, "clearWebhook returns 200");
equal(state.scope.get().webhookUrl, "", "clearWebhook empties the stored webhook");
equal(cleared.json?.config?.webhookConfigured, false, "clearWebhook is reflected in the returned view");

const testAfterClear = await callRoute(state, TEST_PATH, "POST", {});
equal(testAfterClear.status, 502, "test route returns 502 once the webhook is cleared");

process.stdout.write("\n14. error containment\n");
ok(state.logs.every(([level]) => level !== "error"), "event pushes never logged at error level");

webhook.received.length = 0;
await webhook.close();

process.stdout.write(`\n${String(checks - failures)}/${String(checks)} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${String(failures)} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("smoke: PASS\n");
