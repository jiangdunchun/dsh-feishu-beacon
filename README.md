# dsh-feishu-beacon

[![npm](https://img.shields.io/npm/v/dsh-feishu-beacon)](https://www.npmjs.com/package/dsh-feishu-beacon)
[![license](https://img.shields.io/npm/l/dsh-feishu-beacon)](LICENSE)
[![downloads](https://img.shields.io/npm/dm/dsh-feishu-beacon)](https://www.npmjs.com/package/dsh-feishu-beacon)
[![stars](https://img.shields.io/github/stars/jiangdunchun/dsh-feishu-beacon)](https://github.com/jiangdunchun/dsh-feishu-beacon)

**English** · [Chinese](README.zh.md)

Send your DeepSeek Harness agent's progress — and the moments that need you — to a Feishu
(Lark) group.

A long agent run has two problems. You don't want to sit and watch it, but if you walk
away you'll miss the moments when it can't continue without you. This plugin solves both:
the agent reports its own milestones to a Feishu bot you configure, and questions,
authorization requests, and failures are pushed whether the agent remembers to report or
not.

```text
PROGRESS
Task: Fix the flaky deploy
Workspace: beacon-project
Time: 2026-09-21 14:20:03

Step 2 of 4 done: the flake is a race in the retry timer, not the deploy script.
```

## What you'll be notified about

| When | What arrives |
|---|---|
| The agent reaches a milestone it judges worth telling you about | Its own message, titled `PLAN`, `PROGRESS`, `DECISION`, or `DONE` |
| The agent needs an answer | `Answer needed`, with every question and every option, including each option's description |
| The agent needs authorization for a sensitive action | `Authorization needed`, with the tool name and the reason |
| A run fails | `Turn failed`, with the error |

**A successful run notifies you of nothing.** If you finish a task and your phone stays
quiet, that is the plugin working: reporting every completed run is noise, and this plugin
exists to avoid it.

## Before you start

- The `dsh` CLI with a **web** profile.
- A Feishu group you can add a bot to.

## Install

```powershell
dsh plugin --profile web add dsh-feishu-beacon
```

Then **restart the harness**. The settings page only loads at startup, so a running harness
won't show it yet.

## Set it up

### 1. Create the bot in Feishu

Feishu's own guide covers this end to end — where the custom-bot settings live, how to copy
the webhook URL, and how signature verification works:
[Feishu: custom bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)
(the page is in Chinese).

The short version:

1. Open the Feishu group you want the notifications in.
2. **Settings → Bots → Add bot → Custom bot**.
3. Give it a name, and copy the **webhook URL** it shows you.
4. If the bot enables signature verification, copy the **signing secret** as well.

### 2. Paste it into the plugin

Open **Settings → Feishu beacon** and paste the webhook URL. The URL must start with
`https://`. If your bot verifies signatures, paste the secret too; if it doesn't, leave the
secret empty.

There is **no Save button** — your edit is stored as soon as it lands, and a status line
under the fields tells you it was applied. If a value is refused, it stays on screen with
the reason.

### 3. Press "Send test"

`Send test` is the only button on the page. It sends one message right now, using what the
page shows, so it proves three things at once: the URL is right, the secret is right, and
your phone can see the group. That message appears in Feishu within a second or two.

If the page reports a failure instead, see [If it doesn't work](#if-it-doesnt-work).

### 4. Tell the agent to report

Milestone reporting is the agent's decision, so it needs to be asked once:

> report your progress through dsh-feishu-beacon

Questions, authorization requests, and failures need no instruction — they are pushed from
this point on.

## What you can change

Everything lives on the same settings page, and everything applies immediately — there is
nothing to restart.

| Setting | What it does |
|---|---|
| **Enabled** | Master switch. While off, nothing is pushed at all. |
| **Notify on questions** | Push when the agent needs an answer. |
| **Notify on approvals** | Push when the agent needs authorization. |
| **Notify on failed turns** | Push when a run fails. |
| **Title prefix** | Prepended to every title, so you can tell deployments apart — e.g. `[HOME-PC] PROGRESS`. |
| **Host URL in messages** | Adds an `Open at:` line pointing back at your harness. See below. |
| **Max characters** | Whole-message limit, `1800` by default. Longer messages are cut with `...`. |
| **Signing secret** | Only if your bot verifies signatures. |
| **Webhook URL** | The bot's webhook. |

The three notification switches are independent on purpose: turning one off leaves the
others alone.

Both credentials show **stored** or **not set** rather than their value, and `Clear` appears
beside one only while something is stored. Your webhook and secret are kept on the harness
and are never sent back to the browser.

### About "Host URL in messages"

This field controls one line — `Open at:` — and nothing else. Its purpose is the phone: a
Feishu notification carries no session information, so that line is where you tap to get
back to the harness.

- **Reading notifications on the same machine as the harness?** Leave it empty. It falls
  back to `DSH_WEB_URL`, which your harness sets for itself.
- **Reading them on your phone?** The fallback is usually `http://127.0.0.1:<port>`, which
  on a phone points at the phone and won't open. Put in an address your phone can reach —
  your machine's LAN address if you're on the same Wi-Fi, or a tunnel address if you're not.

When neither this field nor `DSH_WEB_URL` is set, the line is simply left out.

## Upgrading from 0.1.x

**0.2.x requires dsh 0.2, and 0.1.1 requires dsh 0.1.x — the two do not cross.** If you run
dsh 0.2, install 0.2.x; on dsh 0.1.x, stay on 0.1.1.

Configuration also moved: values live in the active profile's patch layer now, not in
`settings.yaml`. Re-enter your webhook URL and signing secret after upgrading.

## If it doesn't work

**The plugin doesn't appear in Settings after installing.**
`dsh plugin add` reports success even when installing failed, and a package that isn't
listed as a bundle never loads. Check `$DSH_HOME/profiles/web/package.json` and confirm
`dsh-feishu-beacon` appears in **both** `dependencies` and `dsh.profile.bundles`. If it
doesn't, re-run the install and watch for a pnpm error. The usual cause is an undecided
`allowBuilds:` entry in `$DSH_HOME/profiles/web/pnpm-workspace.yaml` — answer it `false`
(build scripts are useless for a published package) and install again.

**"Send test" fails.**
Check the webhook URL starts with `https://`, and that the signing secret matches the bot
if your bot verifies signatures. A `502` in the page means Feishu itself refused the
message.

**I got no notification.**
First check whether you should have: a run that succeeds sends nothing. Then check the
**Enabled** and the relevant **Notify on…** switches. If a run failed and you still heard
nothing, the push itself failed — the harness log will carry a warning, never an error,
because a failed notification must not break your session.

**The notification arrives but the `Open at:` link doesn't open.**
That address isn't reachable from the device you read the message on. See
[About "Host URL in messages"](#about-host-url-in-messages).

**Messages are cut off.**
They are truncated at **Max characters** (1800 by default). Raise it if you want more, but
note that very long messages are less useful on a phone, which is the point of this plugin.

## Known limits

- **Replies don't come back.** A custom-bot webhook can only send. You cannot answer a
  question from Feishu — the message tells you to come back to the harness.
- **No retry.** A failed push is a lost push. This is why the tool path reports failures to
  the agent, and only the event path stays silent.
- **Very long sessions can repeat a notification.** Duplicate suppression is bounded; after
  a long enough session it starts over.
- **Feishu must be able to reach the webhook**, and your harness must be able to reach
  Feishu. A corporate network that blocks either direction will silently lose messages —
  use `Send test` to check before relying on it.

## Uninstalling

```powershell
dsh plugin --profile web remove dsh-feishu-beacon
```

That removes the package, but **not** its name from the profile's bundle list: dsh only
reconciles `dsh.profile.bundles` while installing, so a removal leaves the name behind and
the next boot tries to load a bundle that is no longer there. Open
`$DSH_HOME/profiles/web/package.json` and delete `"dsh-feishu-beacon"` from
`dsh.profile.bundles` as well, then restart the harness.

Your webhook URL and signing secret stay in the profile's configuration file
(`cordis.patch.yml`). Remove that row too if you want them gone.

## For developers

The rest of this file is about building the plugin itself.

### Layout

The repository root **is** the package:

```text
dsh-feishu-beacon/
├── package.json          exports / files / dsh.bundle / dsh.client
├── cordis.patch.yml      the bundle mount row and the composition config base
├── README.md             this file
├── README.zh.md          the Chinese translation
├── lib/
│   ├── index.js          host half: transport, event layer, tool, Config, routes
│   └── client.js         client half: the settings section
└── test/
    ├── smoke.mjs              host smoke test
    ├── client-smoke.mjs       client contract test
    ├── no-cjk.mjs             the zero-CJK enforcement test
    ├── cordis-mount.mjs       real-registry mount check
    ├── install-load.mjs       installed-profile load check
    ├── live-contract.mjs      running-harness contract check
    ├── pack-install-check.mjs publish-list packaging check
    ├── profile-check.mjs      composed-profile acceptance check
    └── live-check.mjs         one-shot real-webhook check (not published)
```

Only `lib/`, `cordis.patch.yml`, the READMEs, and `LICENSE` ship; everything under `test/`
stays in the repository. Verify with `npm pack --dry-run`.

Every user-visible and model-visible string lives in a `MESSAGES` block in each half, so
translating or making a label configurable touches one place.

### How it works

Two layers, and both are load-bearing:

- **The tool layer.** Only the model can tell "a test just passed" from "the architecture is
  settled", so milestone reporting is a tool, `dsh_beacon`, that the model calls
  deliberately. Its parameters are `message` and an optional `kind`
  (`plan`/`progress`/`decision`/`done`).
- **The event layer.** A tool only fires if the model remembers, and `ask_user_question`,
  `approval/asked`, and a failed `turn/end` are exactly the moments a user has to come
  back. Those three are pushed by session events regardless.

The plugin exports a `Config` schema — every field `.volatile()` — and writes edits through
`ctx.settings.update`; the Loader resolves this row's config against that schema and hands
it to `apply`, re-running `apply` after every edit. Configuration has two layers, later
wins: the `config:` block in `cordis.patch.yml`, then this row's `config:` in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`.

Two HTTP routes serve the settings section:
`/api/dsh-feishu-beacon/config` (`GET` a redacted view, `POST` a patch) and
`/api/dsh-feishu-beacon/test` (`POST` one test message). The `POST` body is a settings
patch: plain fields merge, `clearWebhook` / `clearSecret` unset a stored credential, and an
empty credential string means "keep the stored value".

`webhookUrl` and `secret` are declared `role("secret")`, so dsh strips them from every
wire-facing view. Because "empty" and "unset" are different stored states, clearing uses a
declarative `unset` rather than writing an empty string.

Three Feishu details fail **silently** if you get them wrong: the envelope
(`msg_type: "text"`, `content.text`), the success code (absent is fine, present and
non-zero is a failure), and the signature (`HMAC-SHA256` keyed by `"<timestamp>\n<secret>"`,
empty message, base64 digest). Other chat platforms differ in all three, so changing the
URL is not a port.

### Working on it

```powershell
npm install --ignore-scripts --cache .npm-cache

node test/no-cjk.mjs          # every shipped file is pure ASCII (no CJK)
node test/smoke.mjs           # host half: pushes, dedupe, routes, hot config
node test/client-smoke.mjs    # client half: loader contract, slot, controller, form
node test/cordis-mount.mjs web   # a real Cordis registry mounts and re-applies the export
node test/install-load.mjs web   # the installed profile link resolves and applies
node test/pack-install-check.mjs # the published file set composes into a profile
node test/live-contract.mjs      # a running harness serves the documented contract
```

`npm pack --dry-run` is the packaging check; `test/pack-install-check.mjs` goes further and
composes a throwaway profile from only the files the manifest publishes.

`test/cordis-mount.mjs` is the one that pins the plugin *shape*: it mounts the package's
export through an actual `Context`, and also mounts the pre-0.2 shape — the one that called
`ctx.settings.register` — requiring that to fail, so the check cannot quietly stop testing
anything.

### Publishing

Publishing from `.github/workflows/publish.yml` uses npm **trusted publishing** (OIDC): no
long-lived token exists for this repository, and npm verifies the workflow's short-lived
identity against the trusted publisher configured on the package page. Dispatch that
workflow manually, with its dry-run input if you only want to see the tarball.

If you publish by hand instead, note two traps:

- a staged version **blocks** a direct publish of the same version number, and clearing the
  stage needs a WebAuthn security key. Bump the version instead.
- npm's registry can take several minutes to make a new version visible. A successful
  publish that `npm view` cannot see yet is not a failure — check again.

### Changes

#### 0.2.2

Documentation only; no behaviour changed.

The README was rewritten for the person installing the plugin rather than for someone
reading the source: what lands on your phone, the four setup steps, what each setting means,
troubleshooting, and uninstalling. Developer material moved to the end.

`README.zh.md` is a full Chinese translation, cross-linked from both files.

The setup step now links Feishu's own custom-bot guide, so the Feishu side is documented by
the people who own it.

#### 0.2.1

The release that reaches npm. Its content is identical to the `0.2.0` described below; the
version number moved because `0.2.0` was staged on npm, and a direct publish is refused
over a staged version while clearing the stage needs a WebAuthn security key. Renumbering
is the way out that needs no security key. `0.2.0` is therefore not published and never
will be — do not read its absence as a withdrawn release.

#### 0.2.0 — requires dsh 0.2

**Breaking: this release does not load on dsh 0.1.x, and 0.1.1 does not load on 0.2.** The
host half used to take its configuration from `ctx.settings.register`, which 0.2.0 removed;
it now exports a `Config` schema and writes through `ctx.settings.update`.

The pushed message lost its package-name prefix: the first line is the title alone. `Send
test` now assembles through the same function a milestone does, so the prefix and the
length budget apply to it too.

The settings page was rebuilt on the settings design system: every on/off variable is a
switch, every edit applies itself, and `Send test` is the only button.

#### 0.1.1

Initial published release: the `dsh_beacon` tool, the three event hooks, the redacted
settings section, and the two HTTP routes, verified against dsh `0.1.5-rc.2`.

#### Compatibility

Verified against dsh `0.2.0-rc.2`. dsh is a developer preview and promises breaking
changes, so read that as the version this plugin's host-half contracts were read from, not
as a compatibility promise for later releases.

## License

MIT
