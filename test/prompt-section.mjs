/**
 * The naming rule, against the real system-prompt service.
 *
 * `smoke.mjs` proves the plugin calls `section()` with the shape it believes the
 * service takes. This file proves that belief is right: it mounts the real
 * `SystemPrompt`, applies the plugin to it, assembles, and renders. A stub cannot
 * catch a signature mismatch, a wrong scope, or a disposer that unregisters what it
 * just registered — and this section is the only part of the plugin whose failure
 * cannot be seen from the outside, because it is not a push and produces no error.
 *
 * It also proves the dependency is declared: cordis refuses to read an injected
 * service that was not declared, so the plugin's `systemPrompt` registration would
 * throw at load if the name were missing from `inject`.
 *
 * Run: node test/prompt-section.mjs
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

let checked = 0;
let failures = 0;

function ok(condition, label, detail) {
  checked += 1;
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
    return true;
  }
  failures += 1;
  process.stdout.write(`>  FAIL ${label}${detail === undefined ? "" : `\n         ${detail}`}\n`);
  return false;
}

function equal(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(same, label, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const require = createRequire(join(packageRoot, "test", "probe.cjs"));
const core = require("@deepseek-ai/cordis");
const promptModule = require("@deepseek-ai/dsh-system-prompt");

const SECTION = "dsh-feishu-beacon:naming-rule";

process.stdout.write("\n1. the real service assembles the rule\n");

const config = promptModule.SystemPrompt.Config ? promptModule.SystemPrompt.Config({}) : {};
const root = new core.Context();

/**
 * Provide a plain object under a service name, the way a service plugin does.
 *
 * Assigning onto the context is not enough: a cordis fiber only reaches the active
 * state once every name in its `inject` list is *provided*, and reading an
 * unprovided name throws. An earlier version of this file assigned the stubs
 * directly, which silently produced a plugin that never activated — the section
 * "failed" only because nothing had run.
 *
 * @param name - the service name the plugin injects.
 * @param implementation - the object answering that name.
 * @returns a promise settling once the service is registered.
 */
function provide(name, implementation) {
  return root.plugin({
    name: `stub-${name}`,
    apply(ctx) {
      new (class extends core.Service {
        constructor(ownerContext) {
          super(ownerContext, name);
        }
      })(ctx);
      Object.assign(ctx, { [name]: implementation });
    }
  });
}

const state = { tools: new Map(), routes: new Map(), listeners: [], commands: new Map() };
await root.plugin({
  name: "stub-systemPrompt",
  apply(ctx) {
    Object.assign(ctx, { systemPrompt: new promptModule.SystemPrompt(ctx, config) });
  }
});
const service = root.systemPrompt;
ok(typeof service?.assemble === "function", "the installed profile provides the system-prompt service");
ok(typeof service.section === "function", "the service accepts section registrations");

await provide("tools", { register: (tool) => state.tools.set(tool.name, tool) });
await provide("settings", { update: async () => {}, mutate: async () => {} });
// The row also registers the `/beacon` control command, so `commands` is a declared
// dependency and must be provided, or cordis leaves the fiber inactive and the
// section never registers — a failure this file exists to make visible.
await provide("commands", {
  register: (definition) => {
    state.commands.set(definition.name, definition);
    return () => state.commands.delete(definition.name);
  }
});
await provide("webServer", {
  register: ({ path, handler }) => {
    state.routes.set(path, handler);
    return () => state.routes.delete(path);
  },
  unregister: () => undefined
});
await provide("workspaceRegistry", { resolveByPath: async () => ({ title: "stub" }) });

let mod;
try {
  mod = await import(new URL("../lib/index.js", import.meta.url).href);
} catch (error) {
  process.stdout.write(`\nCannot load ../lib/index.js: ${String(error?.message ?? error)}\n`);
  process.exit(1);
}

ok(mod.inject.includes("systemPrompt"),
  "the host half declares systemPrompt, without which cordis refuses the read");

// The module is handed to cordis as the plugin object, so the registry reads its own
// `inject` export exactly as the loader does — a callback wrapper would bypass the
// declaration and cordis would refuse the service read instead.
const mounted = await root.plugin(mod);
equal(mounted.state, 2, "the row reaches the active state with the real prompt service");

const before = await service.assemble();
const beforeNames = (before.sections ?? []).map((section) => section.name);
ok(beforeNames.includes(SECTION), "the rule is in the assembled prompt", beforeNames.join(", "));

// An assembled section carries the resolved name, text, and interpolation flag — the
// `order` is placement metadata and does not survive assembly, so the registration's
// order is asserted through the plugin's own effect instead, and the placement is
// asserted against the rendered prompt below.
const rule = (before.sections ?? []).find((section) => section.name === SECTION);
equal(rule?.interpolate, false, "the rule is literal text and is not interpolated");

const rendered = promptModule.renderPrompt(before);
ok(rendered.includes("The word \"beacon\" belongs to the user"),
  "the rule reaches the rendered prompt verbatim");
// Placement, not just presence: it must come after the persona prefix and before the
// suffix, which is where tool guidance belongs.
const ruleAt = rendered.indexOf("Naming rule for dsh-feishu-beacon");
const suffixAt = rendered.indexOf("deployment:persona-suffix");
ok(ruleAt > 0 && (suffixAt < 0 || ruleAt < suffixAt),
  "the rule is rendered before the persona suffix");

process.stdout.write("\n2. the row's lifetime owns the rule\n");
// A section is registered through an effect, so it is withdrawn with the row rather
// than left standing. That matters on reload: the service treats a second
// registration of the same name as an error, so a leaked section would break the next
// mount loudly instead of quietly duplicating the rule.
await mounted.dispose();
const afterDispose = (await service.assemble()).sections.map((section) => section.name);
ok(!afterDispose.includes(SECTION), "disposing the row withdraws the rule", afterDispose.join(", "));

// Remounting after a dispose is the reload path, and it must succeed.
const remounted = await root.plugin(mod);
equal(remounted.state, 2, "the row remounts after a dispose");
const afterRemount = (await service.assemble()).sections.filter((section) => section.name === SECTION).length;
equal(afterRemount, 1, "remounting leaves exactly one copy of the rule");
await remounted.dispose();

process.stdout.write("\n3. a composition without a prompt service is a load failure\n");
// The dependency is declared rather than optional on purpose: a row that injects a
// service it never provides keeps the whole plugin from activating, so the failure is
// loud at load instead of silent at push time.
const orphan = new core.Context();
Object.assign(orphan, {
  tools: { register: () => {} },
  on: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  settings: { update: async () => {}, mutate: async () => {} },
  webServer: { register: () => () => {}, unregister: () => undefined },
  workspaceRegistry: { resolveByPath: async () => ({ title: "stub" }) }
});
let threw = false;
try {
  mod.apply(orphan, mod.Config({ webhookUrl: "https://example.invalid/hook" }));
} catch {
  threw = true;
}
ok(threw, "applying without the systemPrompt service throws rather than skipping the rule");

process.stdout.write(`\n${String(checked - failures)}/${String(checked)} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${String(failures)} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("prompt-section: PASS\n");
