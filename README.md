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
PROGRESS
Task: Fix the flaky deploy
Workspace: beacon-project
Time: 2026-09-21 14:20:03

Step 2 of 4 done: the flake is a race in the retry timer, not the deploy script.
```

**Verified against dsh `0.2.0-rc.2`** (checked 2026-09-30). dsh is a developer preview and
promises breaking changes, so read that as the version whose host-half contracts this
plugin's code was actually read from, not as a compatibility promise for later releases.

That check is not a formality. Through dsh 0.1.5 the host half obtained its configuration
from `ctx.settings.register`, which returns a scope the plugin reads and writes; 0.2.0
removed that method in favour of a declared `Config` schema plus `ctx.settings.update`. A
plugin written against the older contract cannot load at all on 0.2.0 — its `apply` throws
on the first line — which is why the migration is the whole of the host half's settings
work, and why `test/cordis-mount.mjs` mounts the export through a real registry rather than
trusting a stub.

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
configuration — the profile patch the settings service owns — and are never sent to the
browser, so the settings page can write them and learn whether one is stored, but never
reads them back. An implementation that keeps configuration in `localStorage` puts the bot
secret in the browser.

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
| `dsh_beacon` tool call | `<PLAN\|PROGRESS\|DECISION\|DONE>`, or `prefix` + kind when a prefix is set | the model's message, verbatim |
| `tool/call` = `ask_user_question` | `Answer needed` | every question, every option **with its description**, multi-select marked, plus a "back to your computer" line |
| `approval/asked` | `Authorization needed` | `tool: <name>` and `reason: <reason>` (truncated to 300 characters) |
| `turn/end` with `reason.kind === "error"` | `Turn failed` | `<message> (<code>)`, truncated to 500 characters |

**A successful turn pushes nothing.** Reporting every turn is noise; that is the problem
this plugin was written to avoid. Only a failed turn is news.

Every message carries a header:

```text
PROGRESS
Task: <session title, or the session directory's name>
Workspace: <workspace registry title, or the directory's name>
Time: 2026-01-31 09:14:02
Open at: <the configured host URL, when there is one>    <- optional, see `publicUrl`

<the message>
```

The first line is the title alone. The package name is deliberately not part of it: the
reader already knows which bot sent the message, and repeating it spends the line the
summary belongs on. Set `prefix` to label a deployment that needs one.

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
2. Paste both into **Settings > Feishu beacon**. The URL must be `https://`, and it is
   stored as soon as you stop typing — there is no Save button. Leave the secret empty when
   the bot does not verify signatures.
3. Press **Send test**. The message on your phone is the proof that the URL and the
   signature are both right; `502` in the page means Feishu refused it.

Then tell the agent when to report:

> report your progress through dsh-feishu-beacon

The event layer needs no instruction. Questions, approval requests, and failed turns are
pushed from that point on.

For a scripted install the same values can be written before boot, as a `config:` block on
this plugin's row in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: dsh-feishu-beacon
  config:
    webhookUrl: https://open.feishu.cn/open-apis/bot/v2/hook/<id>
    secret: ''
```

Writing that row by hand is for provisioning only. Day to day the settings page owns it:
dsh's settings service writes the edit back into that same profile patch.

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

`lib/` imports `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`. At runtime the
installation supplies them; for a checkout's own tests, install the published ones into
the checkout's `node_modules`:

```powershell
npm install --ignore-scripts --cache .npm-cache
```

`node_modules/` is excluded by `.gitignore`, and the local npm cache lives inside the
checkout so the install does not need write access anywhere else.

## Configure

The plugin owns no configuration store. It exports a `Config` schema — every field
`.volatile()` — and dsh does the rest: the Loader resolves this row's config against that
schema and hands it to `apply`, and the settings service writes edits back into the active
profile's patch layer.

Two layers, later wins:

1. The `config:` block in this package's `cordis.patch.yml` — the composition base.
2. This row's `config:` in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` — what the
   settings page writes.

A settings edit re-resolves the row and re-runs `apply`, so a change takes effect without
a restart. Volatile fields arrive as live cells rather than plain values, which is why
every read in the host half goes through one accessor.

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

### The settings page

The page follows the shipped settings pages rather than inventing a look: it uses the same
design tokens and the same control geometry as `ui-primitives` (the switch capsule, the
field stack, the input, the hint, and the primary action), so it tracks the theme and
cannot drift from its neighbours.

Three decisions are worth stating because they are deliberate:

- **Every on/off variable is a switch** (`role="switch"`, `aria-checked`), not a checkbox.
- **Nothing is staged behind a save.** Typing debounces briefly and then writes; a switch
  writes at once. There is no Save button, because a save step would let the page show a
  value the host does not hold — and a webhook URL is exactly the setting a user tries and
  then walks away from. The fields are grouped under *Connection*, *Messages*, and
  *Notifications*, and each applied edit reports itself in a status line.
- **`Send test` is the only button.** Sending a message is not a configuration change, so
  it is the one action that is not an edit. It flushes any pending edit first and then
  tests with what the page shows.

A refused write keeps its text on screen and reports the host's own message, so the user
can correct it instead of retyping it.

### Credentials

`webhookUrl` and `secret` are declared `role("secret")`, so the settings service strips
them from every wire-facing view. The settings page can write them and can learn whether
one is stored, but never receives the value back — which is why a credential field shows
`stored` or `not set` rather than a value. On the config route:

- an **empty** credential string means "keep the stored value", so a write-only form
  cannot wipe a secret by accident;
- clearing is explicit, through `clearWebhook: true` or `clearSecret: true`, which travels
  to the settings service as a declarative `unset`. That matters because "empty" and
  "unset" are different stored states: `unset` falls back to the composition default,
  while an empty string is a value. The page offers `Clear` beside a credential only while
  one is actually stored.

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
| `/api/dsh-feishu-beacon/config` | `POST` | Apply a patch through the settings service. `400` for a non-`https://` webhook URL; `405` for other methods. |
| `/api/dsh-feishu-beacon/test` | `POST` | Send one test message. `502` when the webhook is unset or Feishu rejects the message. |

The `POST` body is a settings patch: plain fields merge, `clearWebhook` / `clearSecret`
unset a stored credential, and an empty credential string is ignored.

## Tests

The first three run without a real harness and without touching the network.

```powershell
node test/no-cjk.mjs          # every shipped file is pure ASCII (no CJK)
node test/smoke.mjs           # host half: registration, pushes, dedupe, routes, hot config
node test/client-smoke.mjs    # client half: loader contract, slot, controller, form
node --check lib/index.js
node --check lib/client.js
```

`test/smoke.mjs` starts a local HTTP server that stands in for the Feishu webhook and
records what it receives. It drives the plugin through a hand-built `ctx`, but it does not
invent the configuration contract: it stores a patch, resolves it against the plugin's own
exported `Config` schema, and re-applies the plugin — the same order the runtime uses — so
what it asserts on is a row the plugin was actually handed.

Two more checks read the installed profile rather than this package, which is how you
prove the plugin really loaded there:

```powershell
node test/install-load.mjs web         # the profile link resolves and the host half applies
node test/cordis-mount.mjs web         # a real Cordis registry mounts and re-applies the export
node test/pack-install-check.mjs       # the published file set composes into a profile
```

`test/pack-install-check.mjs` stages a throwaway `$DSH_HOME` under `tmp/` and copies in
**only the files `package.json` publishes**, then composes that profile — so a file `files`
forgets to ship fails here rather than on a user's machine. It is spelled out separately
because `test/profile-check.mjs` composes the *real* harness home, which rewrites its
`cordis.yml`; that check therefore cannot run from a confined shell, while this one can.

`test/cordis-mount.mjs` is the one that pins the plugin *shape*: it mounts the package's
export through an actual `Context`, so the registry reads `Config` off it and validates the
row config exactly as dsh does. It also mounts the pre-0.2 shape — the one that called
`ctx.settings.register` — and requires that to fail, so the check cannot quietly stop
testing anything.

One check talks to a **running** harness, so it needs no fixtures and cannot run in CI:

```powershell
node test/live-contract.mjs            # defaults to http://127.0.0.1:3080
node test/live-contract.mjs http://127.0.0.1:3080
```

`test/live-contract.mjs` is the only check that exercises a booted instance: that the two
routes are actually mounted on the webserver, that the redacted view has the documented
shape, that the credentials stored in the profile patch never appear in a response, and
that the refusal paths (`405`, `400` for a bad body, `400` for a non-`https://` webhook)
hold on the wire.

There is also one test that is *supposed* to touch the network, for the final
end-to-end confirmation on a real phone:

```powershell
node test/live-check.mjs https://open.feishu.cn/open-apis/bot/v2/hook/<id> [signing-secret]
```

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
│   ├── index.js          host half: transport, event layer, tool, Config, routes
│   └── client.js         client half: the settings section
└── test/
    ├── smoke.mjs          host smoke test
    ├── client-smoke.mjs   client contract test
    ├── no-cjk.mjs         the zero-CJK enforcement test
    ├── cordis-mount.mjs   real-registry mount check
    ├── install-load.mjs   installed-profile load check
    ├── live-contract.mjs  running-harness contract check (needs a booted instance)
    ├── profile-check.mjs  composed-profile acceptance check
    ├── pack-install-check.mjs  publish-list packaging check
    └── live-check.mjs     one-shot real-webhook check (not published)
```

`files` in `package.json` decides what a tarball carries, so only `lib/`,
`cordis.patch.yml`, `README.md`, and `LICENSE` ship; everything under `test/` stays in
the repository. Verify with `npm pack --dry-run`.

Every user-visible and model-visible string lives in a `MESSAGES` block in each half, so
translating or making a label configurable touches one place.

## Changes

### 0.2.1

The release that reaches npm. Its content is identical to the `0.2.0` described below; the
version number moved because `0.2.0` was staged on npm and direct publishing is refused
over a staged version, while approving or rejecting that stage needs a WebAuthn security
key. Renumbering is the way out that needs no security key.

`0.2.0` is therefore not published and never will be. Do not read its absence as a
withdrawn release.

### 0.2.0 — requires dsh 0.2

**Breaking: this release does not load on dsh 0.1.x, and 0.1.1 does not load on 0.2.**
The host half took its configuration from `ctx.settings.register`, which returns a scope
the plugin reads and writes; 0.2.0 removed that method. The plugin now exports a `Config`
schema — every field `.volatile()` — and writes edits through `ctx.settings.update`, which
is the shape the 0.2 loader resolves a row against.

Configuration moved with it: the settings service stores this row's values in the active
profile's patch layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`), not in
`settings.yaml`.

The pushed message format changed:

- the first line is the title alone — `PROGRESS`, `TEST` — instead of
  `dsh-feishu-beacon - PROGRESS`. Set `prefix` to label a deployment;
- `Send test` assembles through the same function a milestone does, so `prefix` and the
  `maxChars` budget apply to it too.

The settings page was rebuilt on the settings design system, and now:

- every on/off variable is a switch (`role="switch"`), not a checkbox;
- every edit applies itself — there is no Save button. Typing debounces briefly, a switch
  writes at once, and a refused write keeps its text and reports the host's message;
- `Send test` is the only button.

### 0.1.1

Initial published release: the `dsh_beacon` tool, the three event hooks, the redacted
settings section, and the two HTTP routes, verified against dsh `0.1.5-rc.2`.

## License

MIT
