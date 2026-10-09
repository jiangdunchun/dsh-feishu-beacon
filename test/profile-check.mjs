/**
 * Acceptance check for the installed profile: does the composed tree actually
 * contain this plugin's row?
 *
 * The failure this guards against is specific and quiet. `dsh plugin add`
 * forwards to pnpm and only reconciles `dsh.profile.bundles` when pnpm exits
 * zero, so a package can be installed and still never load. Reading the
 * composed tree is the only way to see that from the outside.
 *
 * Usage:
 *   node test/profile-check.mjs [profile-name] [path-to-dsh-checkout]
 *
 * The dsh checkout is located in this order, so the same check works on a
 * development machine and in CI:
 *
 *   1. the second argument
 *   2. $DSH_CHECKOUT
 *   3. `npm root -g` plus @deepseek-ai/dsh (a globally installed dsh)
 *   4. the npx cache this machine booted from
 *
 * The install's own build hash is in the dump module's filename, so the module
 * is found by prefix rather than by a hardcoded name.
 */

import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const profile = process.argv[2] ?? "web";

/** @deepseek-ai/dsh under npm's global root, when the CLI was installed globally. */
function globalDshRoot() {
  try {
    const root = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return root.length > 0 ? join(root, "@deepseek-ai", "dsh") : undefined;
  } catch {
    return undefined;
  }
}

/** The npx cache entry, named by the hash npx gave that installation. */
function npxDshRoot() {
  const base = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx")
    : join(process.env.HOME ?? "", ".npm", "_npx");
  if (!existsSync(base)) return undefined;
  for (const entry of readdirSync(base)) {
    const candidate = join(base, entry, "node_modules", "@deepseek-ai", "dsh");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const dshRoot = process.argv[3] ?? process.env.DSH_CHECKOUT ?? globalDshRoot() ?? npxDshRoot();

if (dshRoot === undefined) {
  process.stderr.write("profile-check: cannot locate a dsh installation; pass it as the second argument or set $DSH_CHECKOUT\n");
  process.exit(2);
}

/**
 * The dump-config module that actually exports `runDumpConfig`.
 *
 * The filename carries the install's build hash, so it cannot be hardcoded —
 * and picking "the first `dump-config-*.js`" is not enough either: dsh 0.2.0
 * ships several, and the alphabetically first one is a thin re-export whose
 * `import` succeeds while the destructured binding is `undefined`. The module is
 * therefore chosen by what it exports, not by what it is called.
 *
 * @param root - the dsh installation directory.
 * @returns the module path, or undefined when none of them exports the entry.
 */
async function findDumpModule(root) {
  const lib = join(root, "lib");
  if (!existsSync(lib)) return undefined;
  const candidates = readdirSync(lib)
    .filter((name) => name.startsWith("dump-config-") && name.endsWith(".js"))
    .map((name) => join(lib, name));
  for (const candidate of candidates) {
    try {
      const module = await import(pathToFileURL(candidate).href);
      if (typeof module.runDumpConfig === "function") return candidate;
    } catch {
      /* A module that cannot load is not the entry point; try the next one. */
    }
  }
  return undefined;
}

const dumpModule = await findDumpModule(dshRoot);
const bundleManifest = join(dshRoot, "..", "dsh-base", "cordis.patch.yml");

if (!existsSync(dshRoot)) {
  process.stderr.write(`profile-check: no dsh checkout at ${dshRoot}\n`);
  process.exit(2);
}
if (dumpModule === undefined) {
  process.stderr.write(`profile-check: no dump-config module under ${join(dshRoot, "lib")} exports runDumpConfig; the dsh build layout changed\n`);
  process.exit(2);
}

/** Capture the composed dump by intercepting stdout. */
async function compose() {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof rest.at(-1) === "function") rest.at(-1)();
    return true;
  };
  try {
    const { runDumpConfig } = await import(pathToFileURL(dumpModule).href);
    runDumpConfig(profile, false, [], undefined);
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

let text;
try {
  text = await compose();
} catch (error) {
  process.stderr.write(`profile-check: cannot compose profile "${profile}": ${String(error?.message ?? error)}\n`);
  process.exit(1);
}

/** Whether one top-level row id appears in the dump. */
const hasRow = new RegExp(`^- id: dsh-feishu-beacon$`, "m").test(text);
// The heading carries a ", patched by <layer>" suffix whenever the profile or a
// later bundle overrides a row in this layer, which any real installation does.
// Anchoring the name to the end of the line therefore only passes on a profile
// that never sets a single option.
const hasLayer = /^# == dsh-feishu-beacon(?![A-Za-z0-9._-])/m.test(text);
const hasConfig = /maxChars: 1800/.test(text);
const hasToolRow = /^- id: tools$/m.test(text);
const hasWebServer = /^- id: webserver$/m.test(text);
const hasSettings = /^- id: settings$/m.test(text);
const hasWorkspace = /^- id: workspace$/m.test(text);

const checks = [
  [hasLayer, `bundle layer "dsh-feishu-beacon" is in the composition`],
  [hasRow, `row id "dsh-feishu-beacon" is present`],
  [hasConfig, "the row carries the composition config defaults"],
  [hasToolRow, "the `tools` row is present (the tool registry is injected)"],
  [hasWebServer, "the `webserver` row is present (the routes can be registered)"],
  [hasSettings, "the `settings` row is present (the namespace can be registered)"],
  [hasWorkspace, "the `workspace` row is present (workspace titles resolve)"]
];

let failures = 0;
for (const [passed, label] of checks) {
  process.stdout.write(`  ${passed ? "ok  " : "FAIL"} ${label}\n`);
  if (!passed) failures += 1;
}

if (existsSync(bundleManifest) && !hasLayer) {
  process.stdout.write("  note the profile manifest must list the package in dsh.profile.bundles\n");
}

if (failures > 0) {
  process.stdout.write(`\nprofile-check: FAIL - ${String(failures)} check(s) failed for profile "${profile}"\n`);
  process.exit(1);
}
process.stdout.write(`\nprofile-check: PASS - profile "${profile}" composes with dsh-feishu-beacon\n`);
