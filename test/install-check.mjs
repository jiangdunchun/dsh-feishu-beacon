/**
 * Post-install verification: does the plugin a profile actually installed
 * resolve, and does its host half load?
 *
 * `npm pack --dry-run` compares the tarball against what the author meant to
 * ship. This goes one step further and asks the installed package itself: a
 * missing entry in `files`, an `exports` map that points at a file the tarball
 * dropped, or a host half whose import graph does not resolve all pass a
 * tarball listing and all fail here.
 *
 * It never publishes, never touches the registry, and never calls the network.
 *
 * Usage:
 *   node test/install-check.mjs <profile-directory> <package-name>
 *
 * The profile directory needs only two things: a node_modules entry for the
 * package, and a node_modules/@deepseek-ai holding the host packages the host
 * half imports -- which is exactly the closure a `dsh` installation provides.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [profileArg, packageName] = process.argv.slice(2);

if (profileArg === undefined || packageName === undefined) {
  process.stderr.write("usage: node test/install-check.mjs <profile-directory> <package-name>\n");
  process.exit(2);
}

const profileDir = isAbsolute(profileArg) ? profileArg : resolve(profileArg);

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

if (!existsSync(join(profileDir, "node_modules"))) {
  process.stderr.write(`install-check: ${join(profileDir, "node_modules")} does not exist; the profile is not installed\n`);
  process.exit(2);
}

const require = createRequire(join(profileDir, "noop.js"));
const packageRoot = join(profileDir, "node_modules", packageName);

process.stdout.write(`install-check: profile ${profileDir}\n`);
process.stdout.write(`install-check: package ${packageName}\n\n`);

if (!existsSync(packageRoot)) {
  process.stderr.write(`install-check: ${packageName} is not installed in this profile\n`);
  process.exit(1);
}

/** Resolve one subpath through the package's own `exports` map. */
function resolveThrough(subpath, label) {
  try {
    const resolved = require.resolve(subpath);
    ok(true, `${label} resolves (${resolved.replace(profileDir, "<profile>")})`);
    return resolved;
  } catch (error) {
    ok(false, `${label} resolves`, String(error?.message ?? error));
    return undefined;
  }
}

process.stdout.write("1. package manifest\n");
const manifestPath = require.resolve(`${packageName}/package.json`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
ok(manifest.name === packageName, `manifest name is ${packageName}`, String(manifest.name));
ok(manifest.dsh?.bundle?.patch !== undefined, "manifest declares dsh.bundle.patch", JSON.stringify(manifest.dsh ?? null));
ok(manifest.dsh?.client?.platform === "web", "manifest declares a web client half", JSON.stringify(manifest.dsh?.client ?? null));

const patchPath = join(packageRoot, manifest.dsh?.bundle?.patch ?? "MISSING");
ok(manifest.dsh?.bundle?.patch !== undefined && existsSync(patchPath), "the declared patch file ships in the tarball", patchPath);

const patchText = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
ok(patchText.includes(`name: ${packageName}`), "the patch mounts a row under the package name");

process.stdout.write("\n2. entry points resolve\n");
resolveThrough(packageName, "the host half (exports .)");
resolveThrough(`${packageName}/client`, "the client half (exports ./client)");
resolveThrough(`${packageName}/cordis.patch.yml`, "the patch subpath (exports ./cordis.patch.yml)");

process.stdout.write("\n3. the installed host half loads\n");
try {
  const entry = require.resolve(packageName);
  const loaded = await import(pathToFileURL(entry).href);
  ok(loaded.apply !== undefined && typeof loaded.apply === "function", "the host half exports apply()");
  ok(Array.isArray(loaded.inject), "the host half exports an inject array", JSON.stringify(loaded.inject ?? null));
  ok(loaded.Config !== undefined, "the host half exports a Config schema");
} catch (error) {
  ok(false, "the installed host half imports cleanly", String(error?.message ?? error));
}

process.stdout.write(`\n${String(checks - failures)}/${String(checks)} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${String(failures)} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("install-check: PASS\n");
