# dsh-feishu-beacon

[![npm](https://img.shields.io/npm/v/dsh-feishu-beacon)](https://www.npmjs.com/package/dsh-feishu-beacon)
[![license](https://img.shields.io/npm/l/dsh-feishu-beacon)](LICENSE)
[![downloads](https://img.shields.io/npm/dm/dsh-feishu-beacon)](https://www.npmjs.com/package/dsh-feishu-beacon)
[![stars](https://img.shields.io/github/stars/jiangdunchun/dsh-feishu-beacon)](https://github.com/jiangdunchun/dsh-feishu-beacon)

Push agent progress and human-attention moments to a **Feishu (Lark) custom-bot webhook**.

`dsh-feishu-beacon` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.
It exists because a long agent run has two very different reporting problems, and one
mechanism cannot solve both.

```text
dsh-feishu-beacon - PROGRESS
Task: Fix the flaky deploy
Workspace: beacon-project
Time: 2026-09-21 14:20:03

Step 2 of 4 done: the flake is a race in the retry timer, not the deploy script.
```

**Verified against dsh `0.1.5-rc.2`** (checked 2026-09-21). dsh is a developer preview and
promises breaking changes, so read that as the version whose host-half contracts this
plugin's code was actually read from, not as a compatibility promise for later releases.

## Why this one, and not just any webhook

The ecosystem already has Feishu notification plugins. The four decisions that differ here,
each of which the obvious implementation gets wrong:

| Decision | The obvious implementation | This plugin |
|---|---|---|
| When a turn ends | push every turn, completed included | push **only** `reason.kind === "error"` |
| What a question push contains | one hardcoded line: "waiting for the user" | the **question text and every option**, with descriptions |
| Event switches | one `enabled` flag for everything | `notifyQuestion` / `notifyApproval` / `notifyError`, independent |
| Duplicate events | push again | dedupe by `callId` |

The credential decision matters too: the webhook URL and signing secret live in the host's
settings document and are never sent to the browser, so the settings page can write them and
learn whether one is stored, but never reads them back. An implementation that keeps
configuration in `localStorage` puts the bot secret in the browser.

## Why two layers

**The tool layer — the model reports real milestones.**

A session-event hook can match event types, but it cannot tell "a test just passed"
from "the architecture is settled". Only the model knows what matters. So progress
reporting is a tool, `dsh_beacon`, which the model calls deliberately at the moments
that deserve the user's attention: the task was broken down, a key part finished, a
decision is needed.

**The event layer — the moments that must never be missed.**

A tool only fires if the model remembers to call it. `ask_user_question`, an approval
request, and a failed turn are exactly the moments a user has to come back to the
computer, and missing one is unacceptable. So those three are pushed by session events,
whether or not the model remembers anything.

Neither layer is optional: the tool layer alone misses the critical moments, and the
event layer alone is too blunt to carry real progress.

## What gets pushed

| Trigger | Title | Body |
|---|---|---|
| `dsh_beacon` tool call | `dsh-feishu-beacon - <PLAN\|PROGRESS\|DECISION\|DONE>` | the model's message, verbatim |
| `tool/call` = `ask_user_question` | `Answer needed` | every question, every option **with its description**, multi-select marked, plus a "back to your computer" line |
| `approval/asked` | `Authorization needed` | `tool: <name>` and `reason: <reason>` (truncated to 300 characters) |
| `turn/end` with `reason.kind === "error"` | `Turn failed` | `<message> (<code>)`, truncated to 500 characters |

**A successful turn pushes nothing.** Reporting every turn is noise; that is the problem
this plugin was written to avoid. Only a failed turn is news.

Every message carries a header:

```text
dsh-feishu-beacon - PROGRESS
Task: <session title, or the session directory's name>
Workspace: <workspace registry title, or the directory's name>
Time: 2026-01-31 09:14:02
Open at: http://127.0.0.1:3080        <- optional, see `publicUrl`

<the message>
```

Messages longer than `maxChars` (default 1800) are truncated with an ellipsis.

## Install

Requires the `dsh` CLI and a **web** profile. Nothing else: the package has no runtime
dependencies beyond Node's built-in `fetch` and `node:crypto`.

```powershell
# From npm:
dsh plugin --profile web add dsh-feishu-beacon

# From a local checkout — the repository root is the package:
dsh plugin --profile web add C:\path\to\dsh-feishu-beacon
```

Then **restart the harness** — the client half (the settings section) only loads at boot —
and open **Settings > Feishu beacon**.

## First run

The plugin is inert until it has a webhook URL: the `dsh_beacon` tool throws and no event is
pushed. Three steps:

1. In Feishu, create a **custom bot** in the group you want the messages in, and copy its
   webhook URL. If the bot has signature verification enabled, copy the signing secret too.
2. Paste both into **Settings > Feishu beacon**. The URL must be `https://`. Leave the
   secret empty when the bot does not verify signatures.
3. Press **Send test**. The message on your phone is the proof that the URL and the
   signature are both right; `502` in the page means Feishu refused it.

Then tell the agent when to report:

> report your progress through dsh-feishu-beacon

The event layer needs no instruction. Questions, approval requests, and failed turns are
pushed from that point on.

For a scripted install the same values can be written before boot, in
`$DSH_HOME/settings.yaml`:

```yaml
dsh-feishu-beacon:
  webhookUrl: https://open.feishu.cn/open-apis/bot/v2/hook/<id>
  secret: ''
```

### Verify the install actually landed

`dsh plugin add` forwards to pnpm and only reconciles `dsh.profile.bundles` when pnpm
exits zero. If pnpm fails, the package is installed but never loaded — with no obvious
symptom. So after installing, check
`$DSH_HOME/profiles/web/package.json` and confirm the name appears in
**both** `dependencies` and `dsh.profile.bundles`.

The usual cause of a non-zero pnpm exit is a pending `allowBuilds` placeholder in
`$DSH_HOME/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  some-pkg: set this to true or false     # <- pnpm left this undecided
```

Resolve it to `true` or `false` (for a published package, build scripts are usually
useless, so `false` is the right answer), then re-run `dsh plugin add`.

### Local development

`lib/` imports `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`. Those resolve
only inside the profile closure, so a checkout needs a junction to it:

```powershell
New-Item -ItemType Directory -Force node_modules | Out-Null
New-Item -ItemType Junction -Path node_modules\@deepseek-ai `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
```

The junction points at this machine's profile, so it must never be committed or
published; `.gitignore` excludes `node_modules/`.

To remove it, use `cmd /c rmdir node_modules\@deepseek-ai`. Do **not** use
`Remove-Item -Recurse`: on some PowerShell versions that follows the junction and
deletes the target's contents, which destroys your profile closure.

## Configure

Two layers, later wins:

1. The `config:` block in this package's `cordis.patch.yml` — the composition base.
2. The `dsh-feishu-beacon:` section in `$DSH_HOME/settings.yaml` — what the settings page writes.

`$DSH_HOME/settings.yaml` is watched and hot-published, and this plugin re-reads the
resolved configuration before **every** push, so a change takes effect without a restart.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `webhookUrl` | secret string | `""` | Feishu custom-bot webhook URL. Must be `https://`. |
| `secret` | secret string | `""` | Bot signing secret. Leave empty when the bot does not verify signatures. |
| `enabled` | boolean | `true` | Master switch. When false, the tool throws and no event is pushed. |
| `prefix` | string | `""` | Prepended to every pushed title. |
| `notifyQuestion` | boolean | `true` | Push `ask_user_question` calls. |
| `notifyApproval` | boolean | `true` | Push approval requests. |
| `notifyError` | boolean | `true` | Push failed turns. Successful turns are always silent. |
| `maxChars` | number | `1800` | Whole-message budget; longer messages are truncated. |
| `publicUrl` | string | `""` | Adds an `Open at:` line. Falls back to `DSH_WEB_URL`, then to no line. |

`notifyQuestion`, `notifyApproval`, and `notifyError` are three independent switches on
purpose: turning off one class of event must not turn off the others.

### Credentials

`webhookUrl` and `secret` are declared `role("secret")`, so the settings service strips
them from every wire-facing view. The settings page can write them and can learn whether
one is stored, but never receives the value back. On the config route:

- an **empty** credential string means "keep the stored value", so a write-only form
  cannot wipe a secret by accident;
- clearing is explicit, through `clearWebhook: true` or `clearSecret: true`.

## The `dsh_beacon` tool

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `message` | string | yes | The text to push. It must stand alone: the user may see only this message. |
| `kind` | string | no | `plan`, `progress`, `decision`, or `done`. Defaults to `progress`. Used for the title. |

The tool's description is the model-facing instruction, so enabling the plugin is a
matter of telling the agent to use it:

> report your progress through dsh-feishu-beacon

## HTTP routes

The settings page talks to the host through two routes:

| Route | Method | Purpose |
|---|---|---|
| `/api/dsh-feishu-beacon/config` | `GET` | Redacted configuration view. Never contains a credential. |
| `/api/dsh-feishu-beacon/config` | `POST` | Apply a patch. `400` for a non-`https://` webhook URL; `405` for other methods. |
| `/api/dsh-feishu-beacon/test` | `POST` | Send one test message. `502` when the webhook is unset or Feishu rejects the message. |

## Tests

All three run without a real harness and without touching the network.

```powershell
node test/no-cjk.mjs          # every shipped file is pure ASCII (no CJK)
node test/smoke.mjs           # host half: registration, pushes, dedupe, routes, hot config
node test/client-smoke.mjs    # client half: loader contract, slot, controller, form
node --check lib/index.js
node --check lib/client.js
```

There is also one test that is *supposed* to touch the network, for the final
end-to-end confirmation on a real phone:

```powershell
node test/live-check.mjs https://open.feishu.cn/open-apis/bot/v2/hook/<id> [signing-secret]
```

And one check that reads the installed profile rather than this package, which is how
you prove the bundle actually loaded:

```powershell
node test/profile-check.mjs web
```

`test/smoke.mjs` starts a local HTTP server that stands in for the Feishu webhook and
records what it receives. It drives the plugin through a hand-built `ctx` and — this
matters — asserts against the settings scope that `apply` itself created, captured from
the `settings.register` stub. Asserting against a scope built by the test would only
test the test.

## Feishu specifics

Three details are Feishu-only. Getting them wrong fails **silently**: the message is
dropped while the sender reports success.

```js
// Envelope
{ msg_type: "text", content: { text: "..." } }

// Success code: absent means fine, present and non-zero means failure.
const code = json?.code ?? json?.StatusCode;
if (typeof code === "number" && code !== 0) throw new Error(...);

// Signature: the signed string is "<timestamp>\n<secret>", the HMAC key is that
// whole string, the message is EMPTY, and the digest is base64.
const sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
```

Other chat platforms use a different envelope (`msgtype` plus `text.content`), a
different success code (`errcode`), and a different signing algorithm, so porting this
by changing the URL will not work.

## Known limits

- **Transport is one-way.** A custom-bot webhook cannot receive replies, so the user
  cannot answer a question from Feishu. The push tells them to come back to the harness.
- **Deduplication is per `callId`.** Repeated `tool/call`, `approval/asked`, and
  `turn/end` events for the same id push once. Events that carry no `callId` fall back to
  a session-plus-offset key, which can collapse two genuinely different pushes of the
  same session into one.
- **The dedupe table is bounded.** It is dropped wholesale at 500 entries, so a very long
  session can, in principle, push the same id twice after the reset.
- **Push failures are logged, never raised.** An event push must not be able to break a
  session, so delivery failures are contained and reported as warnings.
- **No retry.** A failed push is a lost push. The tool's error return is what tells the
  model; events only log.
- **`publicUrl` falls back to `DSH_WEB_URL`.** When neither is set, messages carry no
  link, which is fine for a phone notification but less useful for a deep link.

## Layout

The repository root **is** the package, the way the other published dsh plugins are laid
out: `dsh plugin add <path>` from a checkout installs the root directly, and
`package.json` in the root is the published manifest.

```text
dsh-feishu-beacon/
├── package.json          exports / files / dsh.bundle / dsh.client
├── cordis.patch.yml      the bundle mount row and the composition config base
├── README.md
├── LICENSE
├── .gitignore
├── lib/
│   ├── index.js          host half: transport, event layer, tool, settings, routes
│   └── client.js         client half: the settings section
└── test/
    ├── smoke.mjs          host smoke test
    ├── client-smoke.mjs   client contract test
    ├── no-cjk.mjs         the zero-CJK enforcement test
    ├── profile-check.mjs  composed-profile acceptance check
    └── live-check.mjs     one-shot real-webhook check (not published)
```

`files` in `package.json` decides what a tarball carries, so only `lib/`,
`cordis.patch.yml`, `README.md`, and `LICENSE` ship; everything under `test/` stays in
the repository. Verify with `npm pack --dry-run`.

Every user-visible and model-visible string lives in a `MESSAGES` block in each half, so
translating or making a label configurable touches one place.

## License

MIT
