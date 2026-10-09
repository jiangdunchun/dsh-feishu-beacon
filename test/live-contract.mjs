/**
 * Live contract check for the running harness.
 *
 * The repository's own checks never touch a real host: they drive `apply`
 * through a stub context. This one talks to a booted dsh over HTTP, so it
 * covers the two things a stub cannot — that the routes are actually mounted on
 * the webserver, and that the redacted configuration view is what the wire
 * really carries.
 *
 * The redaction assertions are the point. `webhookUrl` and `secret` are declared
 * `role("secret")`, so the settings service strips them from every wire-facing
 * view; a view that leaked one would put the bot credential in the browser.
 * Only the shape is checked here, never a value.
 *
 * Usage:
 *   node test/live-contract.mjs [base-url]
 *
 * Defaults to http://127.0.0.1:3080 (or DSH_WEB_URL).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const base = (process.argv[2] ?? process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080").replace(/\/+$/, "");
const CONFIG = `${base}/api/dsh-feishu-beacon/config`;
const TEST = `${base}/api/dsh-feishu-beacon/test`;

let checks = 0;
let failures = 0;

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

/** The keys a redacted configuration view is allowed to carry. */
const VIEW_KEYS = [
  "enabled",
  "prefix",
  "notifyQuestion",
  "notifyApproval",
  "notifyError",
  "maxChars",
  "publicUrl",
  "webhookConfigured",
  "secretConfigured"
];

/**
 * The credentials the host actually holds.
 *
 * Read from the profile patch the settings service writes, so the redaction
 * assertions compare against real stored values rather than a guess at their
 * shape. Only the two known keys are extracted; the file is never printed.
 *
 * @returns the stored pair, or undefined when the profile cannot be read.
 */
function readStoredCredentials() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
  const profile = process.env.DSH_PROFILE ?? "web";
  const path = join(home, "profiles", profile, "cordis.patch.yml");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const value = (key) => {
    const match = new RegExp(`^\\s+${key}:\\s*(.*)$`, "m").exec(text);
    if (match === null) return "";
    return match[1].trim().replace(/^['"]|['"]$/g, "");
  };
  return { webhookUrl: value("webhookUrl"), secret: value("secret") };
}

process.stdout.write(`live-contract: ${base}\n`);

process.stdout.write("\n1. the configuration route answers\n");
let response;
let body;
try {
  response = await fetch(CONFIG, { headers: { accept: "application/json" } });
  body = await response.text();
} catch (error) {
  process.stdout.write(`  FAIL the config route is reachable: ${String(error?.message ?? error)}\n`);
  process.stdout.write("\nlive-contract: cannot reach a running harness; start it and retry\n");
  process.exit(1);
}

ok(response.status === 200, "GET /config answers 200", `status ${String(response.status)}`);
ok((response.headers.get("content-type") ?? "").includes("application/json"),
  "the response is JSON", response.headers.get("content-type") ?? "(no content-type)");
ok(response.headers.get("cache-control") === "no-store",
  "the response is never cached", response.headers.get("cache-control") ?? "(no cache-control)");

let view;
try {
  view = JSON.parse(body);
} catch (error) {
  ok(false, "the body parses as JSON", String(error?.message ?? error));
}

if (view !== undefined) {
  process.stdout.write("\n2. the view is the redacted shape\n");
  for (const key of VIEW_KEYS) ok(Object.hasOwn(view, key), `the view carries "${key}"`);
  const extra = Object.keys(view).filter((key) => !VIEW_KEYS.includes(key));
  ok(extra.length === 0, "the view carries no key beyond the documented shape", extra.join(", "));

  ok(!Object.hasOwn(view, "webhookUrl"), "the view has no webhookUrl key");
  ok(!Object.hasOwn(view, "secret"), "the view has no secret key");
  ok(typeof view.webhookConfigured === "boolean", "webhookConfigured is a boolean, not a value");
  ok(typeof view.secretConfigured === "boolean", "secretConfigured is a boolean, not a value");
  ok(typeof view.maxChars === "number" && view.maxChars > 0, "maxChars is a positive number");
  for (const key of ["enabled", "notifyQuestion", "notifyApproval", "notifyError"]) {
    ok(typeof view[key] === "boolean", `${key} is a boolean`);
  }

  process.stdout.write("\n3. the stored values never ride the response\n");
  // The strongest available check: read what the host actually stores and
  // require that none of it appears in the body. A tautological "looks like a
  // URL" pattern would pass even while a credential leaked.
  const stored = readStoredCredentials();
  if (stored === undefined) {
    ok(false, "the stored configuration could be read for comparison");
  } else {
    ok(stored.webhookUrl.length === 0 || !body.includes(stored.webhookUrl),
      "the stored webhook URL does not appear in the body");
    ok(stored.secret.length === 0 || !body.includes(stored.secret),
      "the stored signing secret does not appear in the body");
    ok(stored.webhookUrl === "" ? view.webhookConfigured === false : view.webhookConfigured === true,
      "webhookConfigured agrees with what is stored");
    ok(stored.secret === "" ? view.secretConfigured === false : view.secretConfigured === true,
      "secretConfigured agrees with what is stored");
  }
  ok(!/\bhttps?:\/\//i.test(body), "the body carries no URL at all", body.slice(0, 200));
  ok(Buffer.byteLength(body) < 1024, "the whole view is small enough to be a fixed shape",
    `${String(Buffer.byteLength(body))} bytes`);
}

process.stdout.write("\n4. the method contract holds\n");
const getOnTest = await fetch(TEST, { headers: { accept: "application/json" } });
ok(getOnTest.status === 405, "GET /test is refused with 405", `status ${String(getOnTest.status)}`);
const putOnConfig = await fetch(CONFIG, { method: "PUT" });
ok(putOnConfig.status === 405, "PUT /config is refused with 405", `status ${String(putOnConfig.status)}`);
const badJson = await fetch(CONFIG, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{not json"
});
ok(badJson.status === 400, "a malformed body is refused with 400", `status ${String(badJson.status)}`);
const insecure = await fetch(CONFIG, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ webhookUrl: "http://insecure.example/hook" })
});
ok(insecure.status === 400, "a non-https webhook URL is refused with 400", `status ${String(insecure.status)}`);
const insecureBody = await insecure.text();
ok(!/insecure\.example/.test(insecureBody) || /must be an https/.test(insecureBody),
  "the refusal explains the rule", insecureBody.slice(0, 200));

process.stdout.write(`\n${String(checks - failures)}/${String(checks)} checks passed\n`);
if (failures > 0) {
  process.stdout.write("live-contract: FAIL\n");
  process.exit(1);
}
process.stdout.write("live-contract: PASS - the running host serves the documented contract\n");
