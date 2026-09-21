/**
 * Live connectivity check for dsh-feishu-beacon.
 *
 * The three test suites never touch the network. This script is the deliberate
 * opposite: point it at a real Feishu custom-bot webhook and it sends one
 * message, so a human can confirm the phone actually buzzes.
 *
 * It loads the real transport out of `lib/index.js`, so it exercises the same
 * envelope and signature code path the plugin uses at runtime.
 *
 * Usage:
 *   node test/live-check.mjs <https-webhook-url> [signing-secret]
 *
 * Nothing here writes configuration, and this file is not part of the published
 * package (see `files` in package.json).
 */

import { sendFeishu } from "../lib/index.js";

const [webhookUrl, secret] = process.argv.slice(2);

if (typeof webhookUrl !== "string" || !webhookUrl.startsWith("https://")) {
  process.stderr.write("usage: node test/live-check.mjs <https-webhook-url> [signing-secret]\n");
  process.stderr.write("the URL must start with https:// (a Feishu custom-bot webhook)\n");
  process.exit(2);
}

const now = new Date();
const pad = (value) => String(value).padStart(2, "0");
const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

try {
  const result = await sendFeishu(
    webhookUrl,
    `dsh-feishu-beacon live check at ${stamp}. If you can read this on your phone, the webhook and the signature are both correct.`,
    typeof secret === "string" && secret.length > 0 ? { secret } : {}
  );
  process.stdout.write(`live-check: delivered ${JSON.stringify(result)}\n`);
  if (typeof secret === "string" && secret.length > 0) {
    process.stdout.write("live-check: the request was signed\n");
  } else {
    process.stdout.write("live-check: the request was unsigned\n");
  }
} catch (error) {
  process.stderr.write(`live-check: FAILED ${String(error?.message ?? error)}\n`);
  process.exit(1);
}
