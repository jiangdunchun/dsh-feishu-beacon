/**
 * Source-level "no CJK anywhere" check for dsh-feishu-beacon.
 *
 * Every file that ships, plus the tests, must be pure ASCII apart from the CJK
 * ranges this script rejects. The rule is written down rather than remembered,
 * because an unenforced rule rots: a comment typed in another keyboard layout
 * is enough to break it, and the failure is invisible in a terminal that decodes
 * UTF-8 as a legacy code page.
 *
 * Usage: node test/no-cjk.mjs
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

/**
 * CJK ideographs, kana-adjacent CJK punctuation, and the fullwidth/halfwidth
 * forms block. `\u3000-\u303f` is CJK punctuation, `\u3400-\u4dbf` extension A,
 * `\u4e00-\u9fff` the unified block, `\uff00-\uffef` fullwidth forms.
 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/u;

/** Every path in the package that must stay free of CJK. */
const TARGETS = [
  "package.json",
  "cordis.patch.yml",
  "README.md",
  "LICENSE",
  ".gitignore",
  "lib/index.js",
  "lib/client.js",
  "test/smoke.mjs",
  "test/client-smoke.mjs",
  "test/no-cjk.mjs",
  "test/live-check.mjs",
  "test/profile-check.mjs"
];

const offenders = [];

for (const target of TARGETS) {
  const absolute = join(packageRoot, target);
  let info;
  try {
    info = statSync(absolute);
  } catch {
    offenders.push({ target, line: 0, text: "file is missing" });
    continue;
  }
  if (!info.isFile()) {
    offenders.push({ target, line: 0, text: "not a regular file" });
    continue;
  }
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (CJK.test(line)) offenders.push({ target, line: index + 1, text: line });
  });
}

if (offenders.length > 0) {
  process.stdout.write("no-cjk: FAIL - CJK characters found in source\n");
  for (const offender of offenders) {
    process.stdout.write(`  ${relative(packageRoot, join(packageRoot, offender.target))}:${String(offender.line)}: ${offender.text}\n`);
  }
  process.stdout.write(`\n${String(offenders.length)} offending line(s)\n`);
  process.exit(1);
}

process.stdout.write(`no-cjk: PASS - ${String(TARGETS.length)} files scanned, zero CJK characters\n`);
