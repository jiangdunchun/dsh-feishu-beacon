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

/**
 * A React stub: createElement trees, plus enough hook plumbing that a stateful
 * container component can actually run. The section is the one component whose
 * behaviour is not visible in a single render — it debounces writes and applies
 * toggles — so `test/smoke`-style component rendering is not enough for it.
 *
 * `hookStore` holds the current component instance's state; `onUpdate` is what
 * re-renders it, and the driver below sets it.
 */
const hookStore = { state: [], refs: [], cursor: 0, effects: [] };
let onUpdate = null;
let renders = 0;

/** Start a fresh hook pass over a new component instance. */
function beginRender() {
  hookStore.cursor = 0;
  hookStore.effects = [];
}

/**
 * Ask for a re-render on a later turn, the way a real renderer does.
 *
 * Rendering synchronously inside a state setter would re-enter the component
 * from the middle of an event handler.
 */
function requestRender() {
  if (onUpdate === null) return;
  queueMicrotask(() => onUpdate());
}

const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  }),
  useState: (initial) => {
    const index = hookStore.cursor;
    hookStore.cursor += 1;
    if (!Object.hasOwn(hookStore.state, index)) {
      hookStore.state[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      hookStore.state[index],
      (next) => {
        hookStore.state[index] = typeof next === "function" ? next(hookStore.state[index]) : next;
        requestRender();
      }
    ];
  },
  useRef: (initial) => {
    const index = hookStore.cursor;
    hookStore.cursor += 1;
    hookStore.refs[index] ??= { current: initial };
    return hookStore.refs[index];
  },
  useEffect: (effect, deps) => {
    const index = hookStore.cursor;
    hookStore.cursor += 1;
    const previous = hookStore.effectDeps[index];
    const changed = deps === undefined
      || previous === undefined
      || previous.deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((value, position) => !Object.is(value, previous.deps[position]));
    hookStore.effectDeps[index] = { deps };
    if (changed) hookStore.effects.push(effect);
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  Fragment: Symbol("Fragment")
};

/**
 * Load the bundle fresh, so each call re-registers and re-requires.
 *
 * @param timers - the `setTimeout`/`clearTimeout` pair the bundle schedules its
 *   debounce through; the container test substitutes a clock it can advance.
 * @returns the registration entry and the module exports.
 */
function loadBundle(timers) {
  required = [];
  loader.calls.length = 0;
  const source = readFileSync(join(packageRoot, "lib", "client.js"), "utf8");
  const module = { exports: {} };
  const clock = timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const factory = new Function(
    "module", "exports", "window", "fetch", "console", "require", "setTimeout", "clearTimeout",
    source
  );
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
    },
    clock.setTimeout,
    clock.clearTimeout
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

const requests = [];
/** Install one canned fetch response and record the request. */
function stubFetch(status, payload) {
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options?.method, body: options?.body });
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
equal(requests.at(-1)?.url, "/api/dsh-feishu-beacon/config", "load hits the config route");
equal(requests.at(-1)?.method, "GET", "load uses GET");
equal(requests.at(-1)?.body, undefined, "load sends no body");

stubFetch(200, { ok: true, config: { webhookConfigured: true } });
await controller.update({ notifyQuestion: false, prefix: "ci" });
equal(requests.at(-1)?.url, "/api/dsh-feishu-beacon/config", "update hits the config route");
equal(requests.at(-1)?.method, "POST", "update uses POST");
equal(JSON.parse(requests.at(-1)?.body), { notifyQuestion: false, prefix: "ci" }, "update sends the patch verbatim");

stubFetch(200, { ok: true, message: "Test message sent" });
const testResult = await controller.test({ message: "hi" });
equal(requests.at(-1)?.url, "/api/dsh-feishu-beacon/test", "test hits the test route");
equal(requests.at(-1)?.method, "POST", "test uses POST");
equal(JSON.parse(requests.at(-1)?.body), { message: "hi" }, "test sends its payload verbatim");
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
/** Find the first reachable element of one type, rendering through components. */
function findByType(node, type) {
  return findAll(node, (element) => element.type === type)[0];
}

/** Collect every string reachable from a createElement tree, props included. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (node === null || typeof node !== "object") return "";
  const parts = [];
  if (typeof node.props?.label === "string") parts.push(node.props.label);
  if (typeof node.props?.hint === "string") parts.push(node.props.hint);
  if (typeof node.props?.placeholder === "string") parts.push(node.props.placeholder);
  if (typeof node.type === "string") {
    for (const child of node.children ?? []) parts.push(textOf(child));
  } else if (typeof node.type === "function") {
    // A component element at this position renders a subtree; without a
    // reconciler the test has to render it here to see the same tree the
    // browser would.
    const rendered = renderElement(node);
    parts.push(textOf(rendered));
  }
  return parts.filter((part) => part.length > 0).join(" ");
}

/** Render one component element with its own props, the way a reconciler would. */
function renderElement(node) {
  if (typeof node.type !== "function") return node;
  return node.type({ ...node.props, children: node.children });
}

/**
 * Every reachable element matching a predicate, rendered through components so
 * the tree the browser sees is the tree the test walks.
 */
function findAll(node, predicate, found = []) {
  if (node === null || typeof node !== "object") return found;
  if (typeof node.type === "function") return findAll(renderElement(node), predicate, found);
  if (predicate(node)) found.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, found);
  return found;
}

/** Every reachable element whose props carry the given role. */
function roleOf(node, role) {
  return findAll(node, (element) => element.props?.role === role);
}

/** The configuration view a form is rendered against. */
function sampleView(overrides) {
  return {
    enabled: true,
    prefix: "",
    publicUrl: "",
    maxChars: 1800,
    notifyQuestion: true,
    notifyApproval: true,
    notifyError: true,
    webhookConfigured: true,
    secretConfigured: false,
    ...overrides
  };
}

/**
 * Render the pure form half over a view, recording every action it reports.
 *
 * @returns the element tree and the recorded callbacks.
 */
function renderForm(view, overrides) {
  const calls = [];
  const form = mod.Form({
    view,
    draft: {},
    busy: false,
    status: { tone: "note", text: "" },
    onText: (key, value) => calls.push(["text", key, value]),
    onToggle: (key, value) => calls.push(["toggle", key, value]),
    onClearWebhook: () => calls.push(["clear", "webhookUrl"]),
    onClearSecret: () => calls.push(["clear", "secret"]),
    onTest: () => calls.push(["test"]),
    ...overrides
  });
  return { form, calls };
}

stubFetch(200, sampleView());
ok(typeof mod.Form === "function", "the bundle exports the pure form half");
const { form, calls: formCalls } = renderForm(sampleView());
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
  "Send test",
  "Clear",
  "stored"
], "form copy");
containsAll(textOf(form), ["Feishu custom-bot webhook"], "form intro names the transport");
containsAll(textOf(form), ["Feishu beacon"], "the section carries its own page heading");
containsAll(textOf(form), ["Connection", "Notifications", "Messages"], "the page groups its fields");

// --- the three requested layout rules ------------------------------------

process.stdout.write("\n8. layout: one button, switch toggles, grouped fields\n");

/** Every labelled control the page renders, by the label it shows. */
const buttonLabels = findAll(form, (element) => element.type === "button")
  .map((element) => textOf(element));
equal(buttonLabels.filter((label) => label === "Send test").length, 1, "exactly one Send test button");
ok(!buttonLabels.includes("Save"), "there is no Save button: every edit applies itself");
ok(!buttonLabels.includes("Reload"), "there is no Reload button");
equal(buttonLabels.filter((label) => label === "Clear").length, 1, "only the credential that is stored offers Clear");

const switches = roleOf(form, "switch");
equal(switches.length, 4, "every on/off variable is a switch");
equal(switches.map((element) => element.props["aria-checked"]), [true, true, true, true],
  "each switch reports its checked state");
ok(switches.every((element) => element.type === "button"), "each switch is a button");
ok(switches.every((element) => typeof element.props.onClick === "function"), "each switch is clickable");
ok(switches.every((element) => typeof element.props["aria-labelledby"] === "string"),
  "each switch names its label for assistive technology");
ok(findAll(form, (element) => element.props?.type === "checkbox").length === 0,
  "no checkbox stands in for a switch");

process.stdout.write("\n9. layout: switch interaction and credential controls\n");
switches[1].props.onClick();
equal(formCalls.at(-1), ["toggle", "notifyQuestion", false], "clicking an on switch reports the off state");
const offForm = renderForm(sampleView({ notifyQuestion: false, secretConfigured: true })).form;
const offSwitch = roleOf(offForm, "switch")[1];
equal(offSwitch.props["aria-checked"], false, "an off variable renders as unchecked");

const secretForm = renderForm(sampleView({ secretConfigured: true }));
const secretCalls = secretForm.calls;
const clearButtons = findAll(secretForm.form, (element) => element.type === "button")
  .filter((element) => textOf(element) === "Clear");
equal(clearButtons.length, 2, "both stored credentials offer their own Clear");
clearButtons[1].props.onClick();
equal(secretCalls.at(-1), ["clear", "secret"], "the second Clear unsets the signing secret");
clearButtons[0].props.onClick();
equal(secretCalls.at(-1), ["clear", "webhookUrl"], "the first Clear unsets the webhook URL");

const missingForm = renderForm(sampleView({ webhookConfigured: false, secretConfigured: false })).form;
containsAll(textOf(missingForm), ["not set"], "an unset credential reads as not set");
ok(findAll(missingForm, (element) => element.type === "button" && textOf(element) === "Clear").length === 0,
  "nothing offers Clear when no credential is stored");

process.stdout.write("\n10. layout: edits are reported, never staged behind a save\n");
const edits = renderForm(sampleView());
const webhookInput = findAll(edits.form, (element) => element.type === "input")
  .find((element) => element.props.id === "dsh-feishu-beacon-webhook");
ok(webhookInput !== undefined, "the webhook URL has its own input");
webhookInput.props.onChange({ target: { value: "https://example.invalid/hook" } });
equal(edits.calls.at(-1), ["text", "webhookUrl", "https://example.invalid/hook"],
  "typing reports the value for an immediate write");
const enabledInput = findAll(edits.form, (element) => element.type === "input")
  .find((element) => element.props.id === "dsh-feishu-beacon-enabled");
ok(enabledInput === undefined, "the enabled variable is a switch, not an input");

const maxCharsInput = findAll(edits.form, (element) => element.type === "input")
  .find((element) => element.props.id === "dsh-feishu-beacon-max-chars");
maxCharsInput.props.onChange({ target: { value: "900" } });
equal(edits.calls.at(-1), ["text", "maxChars", "900"], "the budget field reports its raw text");

ok(findByType(form, "input") !== undefined, "the form renders inputs");
ok(findByType(form, "button") !== undefined, "the form renders buttons");

process.stdout.write("\n11. container: every edit applies itself\n");

/** A clock the test advances, so a debounce is deterministic. */
function fakeClock() {
  const pending = new Map();
  let next = 1;
  return {
    size: () => pending.size,
    setTimeout: (fn) => {
      const id = next;
      next += 1;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    /** Run every timer scheduled so far, the way an elapsed delay would. */
    advance: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    }
  };
}

/** Let every pending promise settle. */
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

/** Mount the container over one canned view and return a handle on it. */
async function mountSection(timers, view) {
  stubFetch(200, view);
  const loaded = loadBundle({ setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const bundle = loaded.entry.factory((specifier) => {
    if (specifier === "react") return reactStub;
    throw new Error(`unexpected require: ${specifier}`);
  });
  const Section = bundle.Section;
  const tree = { current: null };
  // Effects belong to one mounted instance, so the store resets per mount.
  hookStore.state = [];
  hookStore.refs = [];
  hookStore.effectDeps = [];

  /** One render pass: render the component, then run the effects it scheduled. */
  const pass = () => {
    renders += 1;
    beginRender();
    tree.current = Section({ controller });
    for (const effect of hookStore.effects) effect();
    hookStore.effects = [];
  };

  onUpdate = pass;
  pass();
  await settle();
  pass();
  await settle();
  return {
    get tree() {
      return tree.current;
    },
    render: () => {
      pass();
      return tree.current;
    }
  };
}

/** The input with the given id inside a rendered section. */
function inputById(tree, id) {
  return findAll(tree, (element) => element.type === "input").find((element) => element.props.id === id);
}

/** The switch with the given label id inside a rendered section. */
function switchByLabelId(tree, id) {
  return findAll(tree, (element) => element.props?.role === "switch")
    .find((element) => element.props["aria-labelledby"] === id);
}

const clock = fakeClock();
stubFetch(200, sampleView());
const mounted = await mountSection(clock, sampleView());
ok(mounted.tree !== null && mounted.tree !== undefined, "the container renders once its view has loaded");
ok(renders > 0, "the container re-renders as its state changes");
containsAll(textOf(mounted.tree), ["Send test"], "the loaded section shows its one action");

process.stdout.write("\n12. container: typing debounces, then writes\n");
requests.length = 0;
stubFetch(200, { ok: true, config: sampleView({ prefix: "ci" }) });
const prefixInput = inputById(mounted.tree, "dsh-feishu-beacon-prefix");
ok(prefixInput !== undefined, "the prefix has its input");
prefixInput.props.onChange({ target: { value: "ci" } });
ok(clock.size() === 1, "a text edit schedules one debounced write");
equal(requests.length, 0, "a text edit does not write on every keystroke");
clock.advance();
await settle();
equal(requests.length, 1, "the debounced write lands once");
equal(requests.at(-1)?.url, "/api/dsh-feishu-beacon/config", "the debounced write hits the config route");
equal(JSON.parse(requests.at(-1)?.body), { prefix: "ci" }, "the debounced write carries the typed value");

requests.length = 0;
stubFetch(200, { ok: true, config: sampleView({ maxChars: 900 }) });
const maxCharsContainerInput = inputById(mounted.tree, "dsh-feishu-beacon-max-chars");
maxCharsContainerInput.props.onChange({ target: { value: "900" } });
clock.advance();
await settle();
equal(JSON.parse(requests.at(-1)?.body), { maxChars: 900 },
  "the container converts the budget to the number the route takes");

process.stdout.write("\n13. container: a switch writes at once\n");
requests.length = 0;
stubFetch(200, { ok: true, config: sampleView({ notifyApproval: false }) });
const approvalSwitch = switchByLabelId(mounted.tree, "dsh-feishu-beacon-notify-approval");
ok(approvalSwitch !== undefined, "the approval switch is rendered");
ok(approvalSwitch.props["aria-checked"] === true, "the approval switch starts checked");
approvalSwitch.props.onClick();
await settle();
equal(requests.length, 1, "a toggle writes immediately, without waiting for the debounce");
equal(JSON.parse(requests.at(-1)?.body), { notifyApproval: false }, "the toggle writes the state it was clicked to");
equal(clock.size(), 0, "a toggle leaves no pending debounce behind");

process.stdout.write("\n14. container: Send test writes what the page shows\n");
requests.length = 0;
stubFetch(200, { ok: true, message: "Test message sent" });
const sendTest = findAll(mounted.tree, (element) => element.type === "button")
  .find((element) => textOf(element) === "Send test");
sendTest.props.onClick();
await settle();
equal(requests.length, 1, "Send test makes exactly one request when nothing was pending");
equal(requests.at(-1)?.url, "/api/dsh-feishu-beacon/test", "Send test hits the test route");
equal(JSON.parse(requests.at(-1)?.body), {}, "Send test sends no override when the fields are empty");

requests.length = 0;
stubFetch(200, { ok: true, config: sampleView() });
const mounted2 = await mountSection(fakeClock(), sampleView({ webhookConfigured: false }));
const webhookInput2 = inputById(mounted2.tree, "dsh-feishu-beacon-webhook");
webhookInput2.props.onChange({ target: { value: "https://example.invalid/fresh" } });
// Count from here: the mount's own view load is not part of this exchange.
requests.length = 0;
const sendTest2 = findAll(mounted2.tree, (element) => element.type === "button")
  .find((element) => textOf(element) === "Send test");
sendTest2.props.onClick();
await settle();
equal(requests.length, 2, "Send test flushes the pending edit and then checks delivery");
equal(JSON.parse(requests[0]?.body), { webhookUrl: "https://example.invalid/fresh" },
  "the pending edit is written before the test runs");
equal(JSON.parse(requests[1]?.body), { webhookUrl: "https://example.invalid/fresh" },
  "the test uses the value the page shows");

process.stdout.write("\n15. container: a clear is an explicit unset\n");
stubFetch(200, { ok: true, config: sampleView({ webhookConfigured: false, secretConfigured: false }) });
const mounted3 = await mountSection(fakeClock(), sampleView({ webhookConfigured: true, secretConfigured: true }));
// Count from here: the mount's own view load is not part of this exchange.
requests.length = 0;
const clearButtons3 = findAll(mounted3.tree, (element) => element.type === "button")
  .filter((element) => textOf(element) === "Clear");
equal(clearButtons3.length, 2, "both stored credentials offer Clear");
clearButtons3[0].props.onClick();
await settle();
equal(requests.length, 1, "a clear writes immediately");
equal(JSON.parse(requests.at(-1)?.body), { clearWebhook: true },
  "a clear sends the explicit unset flag rather than an empty value");

process.stdout.write("\n16. container: a refused write says so and does not stick\n");
const refused = await mountSection(fakeClock(), sampleView());
const refusedSwitch = switchByLabelId(refused.tree, "dsh-feishu-beacon-notify-error");
equal(refusedSwitch.props["aria-checked"], true, "the switch starts checked");
stubFetch(500, { ok: false, message: "write refused" });
refusedSwitch.props.onClick();
await settle();
const afterRefusal = switchByLabelId(refused.tree, "dsh-feishu-beacon-notify-error");
equal(afterRefusal.props["aria-checked"], true, "a switch whose write was refused moves back");
containsAll(textOf(refused.tree), ["Could not apply the change"], "the refusal is reported");
containsAll(textOf(refused.tree), ["write refused"], "the host's own message is shown");

process.stdout.write(`\n${String(checks - failures)}/${String(checks)} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${String(failures)} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("client-smoke: PASS\n");
