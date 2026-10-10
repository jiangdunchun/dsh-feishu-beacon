/**
 * Composed-profile acceptance check, run in a throwaway harness home.
 *
 * `test/profile-check.mjs` composes a real profile, and composing one rewrites
 * the profile's root `cordis.yml` — so it needs a writable `$DSH_HOME`. On a
 * machine whose real harness home is not writable (a confined shell, a locked
 * down workstation) that check can therefore never run, which is a bad property
 * for an acceptance check: it would be skipped exactly where it is wanted.
 *
 * This builds the home instead: a temporary `$DSH_HOME` holding a profile that
 * lists this package as a bundle, with the package copied in **from the files
 * `package.json` publishes** rather than from the working tree. That second
 * property is what makes it a packaging check as well — a file `files` forgets
 * to ship fails here, not on a user's machine.
 *
 * The composition runs in this process. Spawning a child would work, but a
 * confined shell cannot open the pipes that capturing its output needs, and this
 * check exists precisely for confined environments.
 *
 * The temporary home lives under `tmp/`, which is git-ignored.
 *
 * Usage:
 *   node test/pack-install-check.mjs [dsh-checkout]
 *
 * The dsh checkout is located in this order:
 *
 *   1. the first argument
 *   2. $DSH_CHECKOUT
 *   3. the globally installed dsh under `npm root -g`
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

/** The files a tarball carries, from the manifest that decides it. */
function publishedPaths() {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  return ["package.json", "README.md", "LICENSE", ...(manifest.files ?? [])];
}

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

/**
 * The dump-config module that actually exports `runDumpConfig`.
 *
 * The filename carries the install's build hash, so it cannot be hardcoded — and
 * "the first `dump-config-*.js`" is not enough either: dsh 0.2.0 ships several,
 * and one of them is a thin re-export whose `import` succeeds while the
 * destructured binding is `undefined`. The module is chosen by what it exports.
 *
 * @param root - the dsh installation directory.
 * @returns the module path, or undefined when none exports the entry.
 */
async function findDumpModule(root) {
  const lib = join(root, "lib");
  if (!existsSync(lib)) return undefined;
  for (const name of readdirSync(lib).filter((entry) => entry.startsWith("dump-config-") && entry.endsWith(".js"))) {
    const candidate = join(lib, name);
    try {
      const module = await import(pathToFileURL(candidate).href);
      if (typeof module.runDumpConfig === "function") return candidate;
    } catch {
      /* A module that cannot load is not the entry point; try the next one. */
    }
  }
  return undefined;
}

/** Capture the composed dump by intercepting stdout. */
async function compose(dumpModule, profile) {
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

/* ------------------------------------------------------------------- the run */

const dshRoot = process.argv[2] ?? process.env.DSH_CHECKOUT ?? globalDshRoot();
if (dshRoot === undefined || !existsSync(dshRoot)) {
  process.stderr.write("pack-install-check: cannot locate a dsh installation; pass it as the first argument or set $DSH_CHECKOUT\n");
  process.exit(2);
}

const scratch = join(packageRoot, "tmp", "pack-install-check");
const home = join(scratch, "home");
const profileDir = join(home, "profiles", "web");

rmSync(scratch, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });

writeFileSync(join(profileDir, "package.json"), `${JSON.stringify({
  name: "dsh-profile-packing-check",
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-feishu-beacon"] } }
}, null, 2)}\n`);

// A copy taken from the publish list, so an unshipped file is caught here.
const installed = join(profileDir, "node_modules", "dsh-feishu-beacon");
mkdirSync(installed, { recursive: true });
for (const entry of publishedPaths()) {
  const source = join(packageRoot, entry);
  if (!existsSync(source)) {
    process.stderr.write(`pack-install-check: ${entry} is listed in package.json but missing from the checkout\n`);
    process.exit(1);
  }
  cpSync(source, join(installed, entry), { recursive: true, dereference: true });
}
process.stdout.write(`pack-install-check: staged only the published files under tmp/\n`);

// The harness home this process composes against.
process.env.DSH_HOME = home;

const dumpModule = await findDumpModule(dshRoot);
if (dumpModule === undefined) {
  process.stderr.write("pack-install-check: no dump-config module exports runDumpConfig; the dsh build layout changed\n");
  process.exit(2);
}

let text;
try {
  text = await compose(dumpModule, "web");
} catch (error) {
  process.stderr.write(`pack-install-check: cannot compose the staged profile: ${String(error?.message ?? error)}\n`);
  process.exit(1);
}

const checks = [
  [/^# == dsh-feishu-beacon(?![A-Za-z0-9._-])/m.test(text), "the bundle layer is in the composition"],
  [/^- id: dsh-feishu-beacon$/m.test(text), "the row id is present"],
  [/name: dsh-feishu-beacon$/m.test(text), "the row resolves this package by name"],
  [/maxChars: 3000/.test(text), "the row carries the composition config defaults"],
  [/format: card/.test(text), "the row carries the composition format default"],
  [/client\.js/.test(readFileSync(join(installed, "package.json"), "utf8")), "the staged manifest declares the client bundle"],
  [existsSync(join(installed, "lib", "index.js")), "the staged copy carries the host half"],
  [existsSync(join(installed, "lib", "client.js")), "the staged copy carries the client half"],
  [existsSync(join(installed, "cordis.patch.yml")), "the staged copy carries the bundle patch"]
];

let failures = 0;
for (const [passed, label] of checks) {
  process.stdout.write(`  ${passed ? "ok  " : "FAIL"} ${label}\n`);
  if (!passed) failures += 1;
}

if (failures > 0) {
  process.stdout.write(`\npack-install-check: FAIL - ${String(failures)} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\npack-install-check: PASS - the published file set composes into a profile\n");
