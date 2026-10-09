/**
 * Real-registry mount check.
 *
 * The other checks drive `apply` by hand. This one mounts the package's export
 * through an actual Cordis registry — the same machinery the dsh loader uses —
 * so the plugin's *shape* is under test and not just its functions:
 *
 *   - the module namespace must satisfy `Plugin.Object` (`apply`), because that
 *     is the shape `unwrapExports` hands the registry;
 *   - the registry reads `Config` off that same object and validates the row
 *     config through it, so a schema the loader cannot apply fails here;
 *   - a configuration change re-runs `apply` with freshly resolved values.
 *
 * These are exactly the properties that broke between dsh 0.1.5 and 0.2.0, and
 * none of them are visible to a hand-built context.
 *
 * Cordis resolves from this package's own `node_modules` — the same anchor the
 * plugin's `@deepseek-ai/dsh-tools` import already uses — so this check works
 * against a checkout whose dependencies are installed.
 *
 * Usage:
 *   node test/cordis-mount.mjs [profile-name]
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const profile = process.argv[2] ?? "web";
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
const profileDir = join(home, "profiles", profile);
const ownRequire = createRequire(join(packageRoot, "package.json"));

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

/**
 * Read the `config:` block out of a bundle patch.
 *
 * The composition base is a plain YAML mapping under the first `config:` key,
 * indented one level deeper. Parsing those scalars directly keeps this check
 * free of a YAML dependency, the way `test/smoke.mjs` does.
 *
 * @param path - the `cordis.patch.yml` to read.
 * @returns the base configuration, or undefined when the file has no config block.
 */
function readBaseConfig(path) {
  const base = {};
  let inConfig = false;
  let seenConfig = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true;
      seenConfig = true;
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
  return seenConfig ? base : undefined;
}

let core;
let manifestPath;
let profileRequire;
try {
  core = await import(pathToFileURL(ownRequire.resolve("@deepseek-ai/cordis")).href);
  profileRequire = createRequire(join(profileDir, "package.json"));
  manifestPath = profileRequire.resolve("dsh-feishu-beacon/package.json");
} catch (error) {
  process.stdout.write(`cordis-mount: cannot resolve dependencies\n  ${String(error?.message ?? error)}\n`);
  process.stdout.write("  run: npm install --ignore-scripts --cache .npm-cache\n");
  process.exit(1);
}

const manifest = (await import(pathToFileURL(manifestPath).href, { with: { type: "json" } })).default;
const pluginPath = join(manifestPath, "..", manifest.main ?? "lib/index.js");
const plugin = await import(pathToFileURL(pluginPath).href);

const state = { tools: new Map(), listeners: [], effects: [], routes: new Map(), writes: [] };
const root = new core.Context();

/**
 * Provide each injected service the way a service plugin does.
 *
 * Assigning properties onto the context is not enough: a Cordis fiber only
 * reaches the active state once every name in its `inject` list is *provided*,
 * so the stub has to go through `Service` exactly as the real ones do.
 *
 * @param name - the service name the plugin injects.
 * @param implementation - the object answering that name.
 * @returns a promise settling once the service is registered and the fiber is active.
 */
function provide(name, implementation) {
  const fiber = root.plugin({
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
  return fiber.await();
}

const settingsService = {
  update: async (ns, patch) => state.writes.push({ ns, kind: "update", patch }),
  mutate: async (ns, ops) => state.writes.push({ ns, kind: "mutate", ops })
};

await Promise.all([
  provide("tools", { register: (tool) => state.tools.set(tool.name, tool) }),
  provide("webServer", {
    register: ({ path, handler }) => {
      state.routes.set(path, handler);
      return () => state.routes.delete(path);
    },
    unregister: (path) => {
      const previous = state.routes.get(path);
      state.routes.delete(path);
      return previous === undefined ? undefined : () => state.routes.set(path, previous);
    }
  }),
  provide("settings", settingsService),
  provide("workspaceRegistry", { resolveByPath: async () => ({ title: "stub" }) })
]);

ok(typeof core.Context === "function", "the installed profile provides a Cordis Context");
ok(typeof core.Service === "function", "the installed profile provides the Service base class");
ok(!Object.hasOwn(settingsService, "register"),
  "the stub settings service has no register(), the way 0.2 does not");

/**
 * The composition base this package ships.
 *
 * `cordis.patch.yml` carries the `config:` block the bundle mounts the row with.
 * It is validated here rather than at boot, because a base config the schema
 * rejects is a startup failure for every profile that installs the plugin.
 */
const baseConfig = readBaseConfig(join(packageRoot, "cordis.patch.yml"));
ok(baseConfig !== undefined, "the bundle patch carries a config base");
const baseResolved = plugin.Config(baseConfig ?? {});
ok(baseResolved?.enabled?.get() === true, "the composition base resolves enabled:true");
ok(baseResolved?.maxChars?.get() === 1800, "the composition base resolves maxChars:1800");
ok(baseResolved?.webhookUrl?.get() === "", "the composition base ships no webhook URL");

const typedBase = plugin.Config({ ...baseConfig, notAField: 1 });
ok(typedBase !== undefined, "an unknown key in the composition base is ignored rather than fatal");
// Schemastery keeps undeclared keys instead of stripping them, so a stray key in
// a profile patch is carried through rather than rejected. Recorded here because
// it is the reason a hand-edited row cannot break the boot.
ok(typedBase?.notAField === 1, "an unknown key is carried through, not rejected");

let fiber;
try {
  fiber = root.plugin(plugin, {
    webhookUrl: "https://example.invalid/hook",
    enabled: true,
    secret: "s3cret",
    prefix: "ci"
  });
  await fiber.await();
} catch (error) {
  ok(false, "the registry mounts the plugin's export shape", String(error?.message ?? error));
}

if (fiber !== undefined) {
  ok(fiber.state === 2, "the fiber reaches the active state", `state ${String(fiber.state)}`);
  ok(state.tools.has("dsh_beacon"), "the mount registered the dsh_beacon tool");

  // The registry read `Config` off the export and validated the row config
  // through it; a volatile field must arrive as a live cell, not a value.
  const resolved = fiber.config;
  ok(resolved?.webhookUrl !== undefined, "the registry resolved the row config through the exported schema");
  ok(typeof resolved?.webhookUrl?.get === "function",
    "a volatile field arrives as a live cell, so apply must unwrap it");
  ok(resolved.webhookUrl.get() === "https://example.invalid/hook",
    "the resolved webhook URL is the configured one");

  const appliedBefore = state.writes.length;
  // `update` takes the raw row config, not the resolved one: the registry reads
  // `Config` off the export and validates again, which is the path a settings
  // edit takes.
  fiber.update({
    webhookUrl: "https://example.invalid/second",
    enabled: true,
    secret: "s3cret",
    prefix: "ci"
  });
  await fiber.await();

  ok(state.writes.length === appliedBefore, "a config change writes nothing back through settings by itself");
  const refreshed = fiber.config;
  ok(refreshed !== undefined && refreshed !== resolved,
    "a config change hands apply a freshly resolved configuration object");
  ok(refreshed?.webhookUrl?.get() === "https://example.invalid/second",
    "the re-applied row holds the edited webhook URL");
  ok(state.tools.size === 1, "re-applying does not leave a second tool registration behind");

  fiber.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Negative control.
 *
 * A check that cannot fail proves nothing, so this mounts the shape this plugin
 * had before the 0.2 migration — a plugin that calls `ctx.settings.register` —
 * and requires the registry to reject it. If a future settings service brings
 * that method back, this control goes red and the assertions above stop being
 * evidence of anything.
 */
if (fiber !== undefined) {
  const oldShape = {
    name: "old-shape",
    inject: ["settings"],
    Config: plugin.Config,
    apply(ctx) {
      ctx.settings.register("dsh-feishu-beacon", plugin.Config, { base: {} });
    }
  };
  const oldFiber = root.plugin(oldShape, { webhookUrl: "https://example.invalid/hook" });
  let oldError;
  try {
    await oldFiber.await();
  } catch (error) {
    oldError = error;
  }
  ok(oldFiber.state !== 2, "the pre-0.2 shape cannot reach the active state",
    `state ${String(oldFiber.state)}`);
  ok(String(oldError?.message ?? "").includes("register"),
    "the pre-0.2 shape fails on the settings call this plugin used to make",
    String(oldError?.message ?? "no error"));
}

if (failures > 0) {
  process.stdout.write(`\ncordis-mount: FAIL - ${String(failures)} check(s) failed for profile "${profile}"\n`);
  process.exit(1);
}
process.stdout.write(`\ncordis-mount: PASS - ${String(checks)} checks; the registry mounts and re-applies the plugin\n`);
