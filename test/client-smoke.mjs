/**
 * Client-half contract test for dsh-feishu-beacon.
 *
 * The client half is not an ES module: it is a self-registering browser bundle.
 * This test stubs `window.__ModuleLoader__` and `react`, loads the bundle, and
 * checks the registration contract, the settings-section slot, and the
 * controller's HTTP surface. Nothing renders, so React's hooks only need to be
 * present, not functional.
 *
 * Usage: node test/client-smoke.mjs
 */

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

/** Assert deep equality through JSON. */
function equal(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, label, `expected ${b}\n       actual   ${a}`);
}

/** Assert that one text contains each fragment. */
function containsAll(text, needles, label) {
  for (const needle of needles) ok(text.includes(needle), `${label}: contains ${JSON.stringify(needle)}`, text.slice(0, 400));
}

/* ---------------------------------------------------------------- the harness */

/** The recorded `load()` call, replaced on every bundle evaluation. */
const loader = { calls: [] };
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loader.calls.push(entry);
    }
  }
};

/** Every module specifier the bundle asked for, in request order. */
let required = [];

/** A React stub: enough for createElement trees and hook calls to not throw. */
const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  Fragment: Symbol("Fragment")
};

/** Load the bundle fresh, so each call re-registers and re-requires. */
function loadBundle() {
  required = [];
  loader.calls.length = 0;
  const source = readFileSync(join(packageRoot, "lib", "client.js"), "utf8");
  const module = { exports: {} };
  const factory = new Function("module", "exports", "window", "fetch", "console", "require", source);
  factory(
    module,
    module.exports,
    globalThis.window,
    (...args) => globalThis.fetch(...args),
    console,
    (specifier) => {
      required.push(specifier);
      if (specifier === "react") return reactStub;
      throw new Error(`unexpected require: ${specifier}`);
    }
  );
  return { entry: loader.calls.at(-1), exports: module.exports };
}

/* ------------------------------------------------------------------ the suite */

process.stdout.write("\n1. module registration\n");
const first = loadBundle();
ok(loader.calls.length === 1, "the bundle calls __ModuleLoader__.load once");
ok(first.entry !== undefined, "load received a registration entry");
equal(first.entry?.id, "dsh-feishu-beacon", "registration id is the package name");
ok(typeof first.entry?.factory === "function", "registration carries a factory function");

process.stdout.write("\n2. dependency surface\n");
const mod = first.entry.factory((specifier) => {
  required.push(specifier);
  if (specifier === "react") return reactStub;
  throw new Error(`unexpected require: ${specifier}`);
});
equal(required, ["react"], "the factory requires react and nothing else");

process.stdout.write("\n3. exports\n");
ok(typeof mod.apply === "function", "exports apply");
ok(typeof mod.inject !== "undefined", "exports inject");
equal(mod.inject, ["slots"], "inject is the slots service only");

process.stdout.write("\n4. settings section slot\n");
const registrations = [];
const clientCtx = {
  slots: {
    inject(name, callback) {
      registrations.push({ kind: "inject", name });
      return callback();
    },
    register(options, component) {
      registrations.push({ kind: "register", options, component });
      return () => {};
    }
  }
};
mod.apply(clientCtx);
const injectCall = registrations.find((row) => row.kind === "inject");
const registerCall = registrations.find((row) => row.kind === "register");
equal(injectCall?.name, "settings.section", "injects the settings.section slot");
equal(registerCall?.options?.name, "settings.section", "registers under settings.section");
equal(registerCall?.options?.id, "dsh-feishu-beacon", "slot id is the package name");
ok(typeof registerCall?.options?.label === "function", "slot label is a function");
equal(registerCall?.options?.label(), "Feishu beacon", "slot label text");
ok(Number.isSafeInteger(registerCall?.options?.order), "slot order is an integer");
ok(typeof registerCall?.component === "function", "the registered slot component is a function");

process.stdout.write("\n5. controller surface\n");
const controller = registerCall?.options?.inject?.().controller;
ok(controller !== undefined, "the slot injects a controller");
ok(typeof controller.load === "function" && typeof controller.update === "function" && typeof controller.test === "function",
  "controller exposes load, update, and test");

const calls = [];
/** Install one canned fetch response and record the request. */
function stubFetch(status, payload) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options?.method, body: options?.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload;
      }
    };
  };
}

stubFetch(200, { webhookConfigured: true, enabled: true });
await controller.load();
equal(calls.at(-1)?.url, "/api/dsh-feishu-beacon/config", "load hits the config route");
equal(calls.at(-1)?.method, "GET", "load uses GET");
equal(calls.at(-1)?.body, undefined, "load sends no body");

stubFetch(200, { ok: true, config: { webhookConfigured: true } });
await controller.update({ notifyQuestion: false, prefix: "ci" });
equal(calls.at(-1)?.url, "/api/dsh-feishu-beacon/config", "update hits the config route");
equal(calls.at(-1)?.method, "POST", "update uses POST");
equal(JSON.parse(calls.at(-1)?.body), { notifyQuestion: false, prefix: "ci" }, "update sends the patch verbatim");

stubFetch(200, { ok: true, message: "Test message sent" });
const testResult = await controller.test({ message: "hi" });
equal(calls.at(-1)?.url, "/api/dsh-feishu-beacon/test", "test hits the test route");
equal(calls.at(-1)?.method, "POST", "test uses POST");
equal(JSON.parse(calls.at(-1)?.body), { message: "hi" }, "test sends its payload verbatim");
equal(testResult?.message, "Test message sent", "test returns the host payload");

process.stdout.write("\n6. host error pass-through\n");
stubFetch(502, { ok: false, message: "Feishu rejected the message: code 19021" });
const hostError = await controller.test({}).then(() => undefined, (error) => String(error?.message ?? error));
equal(hostError, "Feishu rejected the message: code 19021", "the host's message is rethrown verbatim");

stubFetch(500, {});
const bareError = await controller.load().then(() => undefined, (error) => String(error?.message ?? error));
equal(bareError, "Request failed with status 500", "a payload without a message falls back to a status message");

stubFetch(400, { ok: false, message: "webhookUrl must be an https:// URL" });
const httpsError = await controller.update({ webhookUrl: "http://x" }).then(() => undefined, (error) => String(error?.message ?? error));
equal(httpsError, "webhookUrl must be an https:// URL", "update surfaces the host's validation message");

process.stdout.write("\n7. component tree\n");
/** Depth-first search of a createElement tree for a node type. */
function findByType(node, type) {
  if (node === null || typeof node !== "object") return undefined;
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = findByType(child, type);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Collect every string reachable from a createElement tree, props included. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (node === null || typeof node !== "object") return "";
  const parts = [];
  if (typeof node.props?.label === "string") parts.push(node.props.label);
  if (typeof node.props?.hint === "string") parts.push(node.props.hint);
  if (typeof node.props?.placeholder === "string") parts.push(node.props.placeholder);
  if (typeof node.type === "function") return parts.join(" ");
  for (const child of node.children ?? []) parts.push(textOf(child));
  return parts.filter((part) => part.length > 0).join(" ");
}

stubFetch(200, {
  enabled: true,
  prefix: "",
  publicUrl: "",
  maxChars: 1800,
  notifyQuestion: true,
  notifyApproval: true,
  notifyError: true,
  webhookConfigured: true,
  secretConfigured: false
});
ok(typeof mod.Form === "function", "the bundle exports the pure form half");
const form = mod.Form({
  view: {
    enabled: true,
    prefix: "",
    publicUrl: "",
    maxChars: 1800,
    notifyQuestion: true,
    notifyApproval: true,
    notifyError: true,
    webhookConfigured: true,
    secretConfigured: false
  },
  busy: false,
  error: "",
  note: "",
  webhookUrl: "",
  secret: "",
  onWebhookUrl: () => {},
  onSecret: () => {},
  onDraft: () => {},
  onSave: () => {},
  onTest: () => {},
  onClear: () => {},
  onReload: () => {}
});
ok(form !== null && typeof form === "object", "the form renders a tree without a browser");
const formText = textOf(form);
containsAll(formText, [
  "Webhook URL",
  "Signing secret",
  "Title prefix",
  "Host URL in messages",
  "Max characters",
  "Enabled",
  "Notify on questions",
  "Notify on approvals",
  "Notify on failed turns",
  "Save",
  "Send test",
  "Clear",
  "Reload",
  "stored"
], "form copy");
containsAll(textOf(form), ["Feishu custom-bot webhook"], "form intro names the transport");
ok(!formText.includes("Feishu beacon"), "the section label is not duplicated inside the form");
ok(findByType(form, "input") !== undefined, "the form renders inputs");
ok(findByType(form, "button") !== undefined, "the form renders buttons");

const Section = mod.Section ?? registerCall?.component;
const container = Section({ controller });
ok(container !== null && typeof container === "object", "the section container renders its loading state");
containsAll(textOf(container), ["Failed to load the configuration"], "container loading copy");

process.stdout.write(`\n${String(checks - failures)}/${String(checks)} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${String(failures)} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("client-smoke: PASS\n");
