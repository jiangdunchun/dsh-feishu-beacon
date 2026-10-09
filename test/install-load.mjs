/**
 * Installed-bundle load check.
 *
 * `test/profile-check.mjs` reads the composed tree, which needs a dsh build that
 * still exports `runDumpConfig`. This check answers the narrower question that
 * actually matters after an install: does the profile's `node_modules` entry
 * load as a module, and does its host half register the tool, the event hooks,
 * the settings namespace, and the two routes through a stub context?
 *
 * It resolves the package the way dsh does - by name, from the profile
 * directory - so a broken link, a missing export, or a host-half contract
 * change fails here rather than at boot.
 *
 * Usage:
 *   node test/install-load.mjs [profile-name]
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const profile = process.argv[2] ?? "web";
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
const profileDir = join(home, "profiles", profile);

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

/** The package directory the profile's node_modules resolves for this plugin. */
function resolveFromProfile(specifier) {
  const require = createRequire(join(profileDir, "package.json"));
  return require.resolve(`${specifier}/package.json`);
}

let manifestPath;
try {
  manifestPath = resolveFromProfile("dsh-feishu-beacon");
} catch (error) {
  process.stdout.write(`install-load: cannot resolve dsh-feishu-beacon from ${profileDir}\n`);
  process.stdout.write(`  ${String(error?.message ?? error)}\n`);
  process.exit(1);
}

const manifest = (await import(pathToFileURL(manifestPath).href, { with: { type: "json" } })).default;
ok(manifest.name === "dsh-feishu-beacon", "the profile link resolves to this package");
ok(typeof manifest.dsh?.bundle?.patch === "string", "the manifest declares a bundle patch");

/** A stub host context that records everything `apply` registers. */
function makeCtx() {
  const state = {
    tools: new Map(),
    listeners: [],
    routes: new Map(),
    effects: [],
    writes: []
  };
  const ctx = {
    tools: { register: (tool) => state.tools.set(tool.name, tool) },
    on: (event, handler) => state.listeners.push([event, handler]),
    effect: (factory) => state.effects.push(factory),
    // The live webserver exposes `unregister`, which the mount helper calls
    // before registering; the stub carries it so the route path is exercised
    // exactly as it is in production.
    webServer: {
      register: ({ path, handler }) => {
        state.routes.set(path, handler);
        return () => state.routes.delete(path);
      },
      unregister: (path) => {
        const previous = state.routes.get(path);
        state.routes.delete(path);
        return previous === undefined ? undefined : () => state.routes.set(path, previous);
      }
    },
    // The two methods the settings routes may call, and deliberately nothing
    // else: the plugin must not depend on a configuration scope it was not
    // handed.
    settings: {
      update: async (ns, patch) => state.writes.push({ ns, kind: "update", patch }),
      mutate: async (ns, ops) => state.writes.push({ ns, kind: "mutate", ops })
    },
    workspaceRegistry: { resolveByPath: async () => ({ title: "stub" }) },
    logger: { warn: () => {}, info: () => {}, error: () => {} }
  };
  return { ctx, state };
}

/** A fake IncomingMessage carrying an optional JSON body. */
function fakeRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")];
  return {
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
}

/** Drive one route handler and record status and body. */
async function driveRoute(handler, method, body) {
  const record = { status: 0, body: "" };
  const res = {
    writeHead(status) {
      record.status = status;
    },
    write(chunk) {
      record.body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
    }
  };
  await handler(fakeRequest(method, body), res);
  return record;
}

const { ctx, state } = makeCtx();
const modulePath = join(manifestPath, "..", manifest.main ?? "lib/index.js");
const host = await import(pathToFileURL(modulePath).href);

ok(typeof host.apply === "function", "the host half exports apply");
ok(host.name === "dsh-feishu-beacon", "the host half exports the loader id");
ok(Array.isArray(host.inject), "the host half exports its service list");
ok(typeof host.Config === "function", "the host half exports the Config schema");
ok(host.Config?.type === "object", "the Config export is a schemastery object schema");
ok(Object.values(host.Config.dict).every((field) => field.meta?.volatile === true),
  "every Config field is volatile, so the settings page can edit them");

// The resolved configuration the Loader would hand a row: volatile fields are
// live cells, so `apply` must unwrap them rather than compare them as values.
host.apply(ctx, host.Config({ webhookUrl: "https://example.invalid/hook", prefix: "ci" }));

ok(state.tools.has("dsh_beacon"), "apply registers the dsh_beacon tool");
const tool = state.tools.get("dsh_beacon");
ok(typeof tool?.execute === "function", "the tool carries an execute function");
// `defineTool` normalizes the parameter map into a JSON Schema object.
ok(Object.hasOwn(tool?.parameters?.properties ?? {}, "message"), "the tool declares its message parameter");
ok(Array.isArray(tool?.parameters?.required) && tool.parameters.required.includes("message"),
  "the message parameter is required");

const events = state.listeners.map(([event]) => event);
ok(events.every((event) => event === "session/event"), "apply subscribes only to session/event");

// `apply` mounts the routes from `ctx.effect` factories, so the effects run
// first and their disposers are exercised immediately after.
const disposers = [];
for (const factory of state.effects) {
  try {
    const dispose = factory();
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (error) {
    ok(false, "every ctx.effect factory runs", String(error?.message ?? error));
  }
}

const routePaths = [...state.routes.keys()];
ok(routePaths.includes("/api/dsh-feishu-beacon/config"), "apply mounts the config route");
ok(routePaths.includes("/api/dsh-feishu-beacon/test"), "apply mounts the test route");

// The write path must go through the settings service. This is the regression
// the 0.2 migration is about: an older build of this plugin obtained a
// configuration scope from `ctx.settings.register`, which the 0.2 settings
// service does not have, so a row could not even load.
const configRoute = state.routes.get("/api/dsh-feishu-beacon/config");
const writeResponse = await driveRoute(configRoute, "POST", { prefix: "ci", clearSecret: true });
ok(writeResponse.status === 200, "the config route answers a write", `status ${String(writeResponse.status)}`);
ok(state.writes.length > 0, "the config route wrote through the settings service");
ok(state.writes.every((write) => write.ns === "dsh-feishu-beacon"),
  "every settings write names this plugin's entry");
ok(state.writes.some((write) => write.kind === "update" && write.patch.prefix === "ci"),
  "a plain field travels as a settings update");
ok(state.writes.some((write) => write.kind === "mutate"
  && JSON.stringify(write.ops) === JSON.stringify([{ op: "unset", path: ["secret"] }])),
"a credential clear travels as a declarative unset");
ok(!writeResponse.body.includes("clearSecret"), "the response never echoes the request body's secret flag");

for (const dispose of disposers) {
  try {
    dispose();
  } catch (error) {
    ok(false, "every effect disposer runs", String(error?.message ?? error));
  }
}
ok(state.routes.size === 0, "the effect disposers unmount the routes");

if (failures > 0) {
  process.stdout.write(`\ninstall-load: FAIL - ${String(failures)} check(s) failed for profile "${profile}"\n`);
  process.exit(1);
}
process.stdout.write(`\ninstall-load: PASS - ${String(checks)} checks; the installed bundle loads and applies\n`);
