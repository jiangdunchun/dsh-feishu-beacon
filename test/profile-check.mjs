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
 * The default dsh checkout is the npx cache this machine booted from; override
 * it when the harness lives elsewhere.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const profile = process.argv[2] ?? "web";
const dshRoot = process.argv[3] ?? join(
  process.env.LOCALAPPDATA ?? "",
  "npm-cache",
  "_npx",
  "1e7f6d9597241db0",
  "node_modules",
  "@deepseek-ai",
  "dsh"
);

const dumpModule = join(dshRoot, "lib", "dump-config-lFgMwK8i.js");
const bundleManifest = join(dshRoot, "..", "dsh-base", "cordis.patch.yml");

if (!existsSync(dshRoot)) {
  process.stderr.write(`profile-check: no dsh checkout at ${dshRoot}\n`);
  process.exit(2);
}
if (!existsSync(dumpModule)) {
  process.stderr.write(`profile-check: ${dumpModule} is missing; the dsh build layout changed\n`);
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
const hasLayer = /^# == dsh-feishu-beacon$/m.test(text);
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
