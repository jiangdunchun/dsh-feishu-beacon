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
| The agent needs an answer | A `DECISION` card whose first line is `Answer needed`, with every question and every option, including each option's description |
| The agent needs authorization for a sensitive action | A `DECISION` card whose first line is `Authorization needed`, with the tool name and the reason |
| A run fails | `Turn failed`, with the error |

**The card kinds are exactly four** — `PLAN` (the task, broken down), `PROGRESS` (a key step
finished), `DECISION` (you have to act at your computer: choose something, or authorise
something the agent cannot do), and `DONE` (what was delivered). Anything that needs you at
the keyboard is a `DECISION`, whether it is a question or a permission prompt, and the line
under the header says which.

`Turn failed` is the one card outside that set, and it keeps a colour of its own: a run that
broke is not a decision you can answer, and it must not be mistaken for one.

Each one arrives as an interactive card with a colour that says what it is at a glance, or
as plain text if you prefer — see [About "Message format"](#about-message-format).

**A successful run notifies you of nothing.** If you finish a task and your phone stays
quiet, that is the plugin working: reporting every completed run is noise, and this plugin
exists to avoid it.

**And nothing is pushed at all until you ask for it, one task at a time.** While you are at
the keyboard you do not need a phone notification, and the plugin cannot tell whether you
have stepped away — only you can. So silence is the default, and messages go out only while
a *watch* is open on the work in front of you. See
[Watching a task](#watching-a-task).

## Watching a task

A watch is you saying "I am leaving this running; tell me what happens". It opens when you
ask for it and closes by itself when the task is over, so you never have to remember to turn
notifications off.

**Ask in one specific way — your instruction must contain the word `beacon`:**

> beacon me about progress and blockers
> report through dsh-feishu-beacon
> keep me posted with beacon

That word is the entire trigger. The plugin checks your own message for it, so nothing is
reported unless you said it — and things that merely *look* like a request do not count:

| Not a request | Why |
|---|---|
| "simulate an interactive long task" | Long is not the trigger |
| "fix the dsh-feishu-beacon plugin" | **This one does count** — it contains the word |
| a task on a workspace that uses this plugin | The workspace is not your instruction |
| "continue with what we did before" | An earlier request authorised an earlier task, not this one |

The check is deliberately literal. The plugin could try to guess whether you meant it, and
that guess is exactly how a session once started pushing at someone who had asked for
nothing. A rule the agent can reason its way around is not a rule, so the decision is not
left to the agent: the tool refuses to start reporting otherwise.

From that moment on:

| You receive | Until |
|---|---|
| every milestone the agent reports | the turn ends |
| every question it needs answered | the turn ends |
| every authorization request | the turn ends |
| a failure, if the task breaks | the turn ends |

**When the task ends, the watch ends with it.** A watch is opened for the turn it was asked
in, and the turn boundary is the expiry — there is nothing to close and nothing you have to
remember. A failure is the last thing that turn can say, and it is pushed before control goes
back to you, so a task that broke is the one thing that still reaches you.

Asking the agent a question in the middle of a task — answering a decision it raised — does
**not** end the watch. The agent is still working on the same task; it just needs you first.

A watch is a decision the agent makes, not a switch the plugin flips on your behalf: the
agent has to recognise that you asked to be kept informed and open one. So the word in your
instruction is what *authorises* reporting, and the agent acting on it is what *starts* it.

### One task, one authorisation

A watch covers **one task — the work the agent does before it hands control back**. Your next
instruction starts from silence, even if the previous task never reported that it finished, so
you can never be left receiving notifications because a watch outlived the request that opened
it. Ask again — with the word — for the next task.

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

Questions, authorization requests, and failures need no instruction of their own: while a watch
is open they are pushed whether or not the agent remembers to report.

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
| **Max characters** | Whole-message limit, `3000` by default. Longer messages are cut with `...`. |
| **Message format** | `card` (default) or `text`. See below. |
| **Signing secret** | Only if your bot verifies signatures. |
| **Webhook URL** | The bot's webhook. |

The three notification switches are independent on purpose: turning one off leaves the
others alone.

Both credentials show **stored** or **not set** rather than their value, and `Clear` appears
beside one only while something is stored. Your webhook and secret are kept on the harness
and are never sent back to the browser.

### About "Message format"

Messages arrive either as an **interactive card** or as plain text.

- **`card`** (default) — a coloured header bar, the task and timestamp on a quiet line, then
  the message. The colour tells you what the notification is before you read it: red for a
  failure, orange for a decision, green for done, blue for plan and progress.
- **`text`** — everything in one plain block, the way earlier versions sent it.

You do not have to pick correctly. With `card`, if your group refuses an interactive card,
the plugin **resends the same message as text**, so a formatting problem never costs you the
notification. `Send test` tells you when that happened — the message still arrived, but the
page says the card was not accepted, and you can switch to `text` to stop trying.

Use `text` if you want the plainest possible output, or if the extra request on a refused
card is unwelcome.

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
Almost always this is correct. Pushes are silent until your own instruction contains the word
`beacon`, and they stop when the task ends — so a task you never mentioned the word for
reports nothing, by design. Check, in order: did that instruction really contain `beacon`?
Then, should you have been told at all — a run that succeeds sends nothing. Then the
**Enabled** and the relevant **Notify on…** switches. And if a run failed while reporting was
authorised and you still heard nothing, the push itself failed: the harness log will carry a
warning, never an error, because a failed notification must not break your session.

**The agent says it cannot report because beacon was not named.**
That is the plugin refusing to start reporting without your authorisation. It is not asking
you to rephrase: if you want reports, say so with the word `beacon`.

**The notification arrives but the `Open at:` link doesn't open.**
That address isn't reachable from the device you read the message on. See
[About "Host URL in messages"](#about-host-url-in-messages).

**Messages are cut off.**
They are truncated at **Max characters** (3000 by default). Raise it if you want more, but
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

Authorisation is a **literal word in the user's own instruction**, checked by the plugin rather
than inferred by the model. `lib/index.js` folds three facts out of the session log: whether a
watch was recorded, which turn it was recorded in, and what the human last typed — reading only
`user/message` events whose `source.kind` is `user`, so an injected runtime-context snapshot or
skill catalog can never authorise a push. (`message/user` is accepted as well, because this is
the authorisation check: a harness rename would not degrade the gate, it would silence it.) A
queued prompt counts too, since one submitted mid-turn waits as `agent/inbox/spliced` with
`target: "next-turn"` before it becomes a `user/message`.

The turn comparison is what makes the authorisation expire, and it is the *only* thing that
does: nothing writes to the session when a turn ends. That is not an optimisation — dsh refuses
an append made while another append is being published ("session append cannot reenter while
another append is being published"), and the `turn/end` observer runs inside one, so a close
recorded there can never land. It did not land, in a live session: the watch stayed open past
its turn, the tool saw a watch on the session and declined to open one for the next turn, and
every task after the first was refused as unauthorised. The rule is therefore "does the turn
running now have a watch", never "has this session ever been watched", and `test/watch-lifecycle.mjs`
pins both halves of that — including a session stub whose `append` refuses to re-enter, the way
dsh's does.

The card kinds are exactly four (`plan`, `progress`, `decision`, `done`), and they are the whole
vocabulary the agent chooses from. Everything the event layer sends is rendered as one of them:
a question and an approval request are both `DECISION`, because both need you at your computer,
and the body's first line (`Answer needed`, `Authorization needed`) says which. `Turn failed` is
the one deliberate exception — a run that broke is not a decision you can answer, so it keeps its
own title and its own colour, and the red header is what distinguishes it from the orange.

The other half of the rule is not enforcement but **silence**, and it cannot be enforced at all:
the plugin decides whether to push, but nothing it does can stop the model from *writing* the
word. It is therefore registered as a `systemPrompt` section (`order: 950`, between the
file-reference section and the first per-tool section) so it is assembled into every turn, with
`interpolate: false` because the text is not a template. Injecting `systemPrompt` is a hard
dependency: cordis will not activate a row whose declared services are absent.
`test/prompt-section.mjs` drives the real service and asserts the section's name, placement,
wording, and that its disposer withdraws it.

The `/beacon` command is **disabled**, and `commands` is therefore absent from the host half's
`inject` list — a name left there after its use is gone keeps the row from loading entirely.
The registration was withdrawn because a command bypasses exactly the recognition that this rule
is built on, and its strings went with it rather than sitting in the file as dead text.

`webhookUrl` and `secret` are declared `role("secret")`, so dsh strips them from every
wire-facing view. Because "empty" and "unset" are different stored states, clearing uses a
declarative `unset` rather than writing an empty string — the settings page's `Clear` goes
through that path.

The signature covers both formats: `HMAC-SHA256` keyed by `"<timestamp>\n<secret>"`, an
empty message, and a base64 digest, sent as `timestamp` and `sign` query parameters. A card
changes `msg_type` and the body, never the signing.

Three Feishu details fail **silently** if you get them wrong: the text envelope
(`msg_type: "text"`, `content.text`), the card envelope (`msg_type: "interactive"`, `card`),
and the success code (absent is fine, present and non-zero is a failure — which is how a
refused card is detected and why the fallback can work at all). Other chat platforms differ
in all three, so changing the
URL is not a port.

### Working on it

```powershell
npm install --ignore-scripts --cache .npm-cache

node test/no-cjk.mjs          # every shipped file is pure ASCII (no CJK)
node test/smoke.mjs           # host half: pushes, dedupe, routes, hot config
node test/client-smoke.mjs    # client half: loader contract, slot, controller, form
node test/watch-lifecycle.mjs # the push gate: who may be notified, and for how long
node test/cordis-mount.mjs web   # a real Cordis registry mounts and re-applies the export
node test/prompt-section.mjs     # the naming rule reaches every assembled prompt
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

#### 0.2.5

**The pushed card is exactly one of four kinds: `plan`, `progress`, `decision`, `done`.** The
event layer renders through the same four rather than titles of its own. A question and an
authorization request are both `DECISION` — both need you at your computer — and the body's
first line (`Answer needed`, `Authorization needed`) says which. Before this they were sent as
`PROGRESS` cards, which also meant the colours the 0.2.3 notes describe were not true: an
approval request arrived blue, and so did a failure. `Turn failed` remains a card of its own
and is now actually red, because a run that broke is not a decision you can answer.

**Two gate defects, both of which ended reporting after the first task.** The watch is spent
when its turn ends, but the tool asked "has this session ever been watched" instead of "does
the turn running now have a watch", so on the second task it declined to open a watch and then
refused the push — the second task you asked to hear about was the last one you could hear
about. And the watch was supposed to be closed by appending to the session from the `turn/end`
observer, which dsh refuses ("session append cannot reenter while another append is being
published"), so that close never happened. The turn boundary is now the close, read off the
log position, and nothing writes to the session from an observer.

Also: the instruction is read from `user/message`, the event dsh 0.2 actually emits. The code
looked only for `message/user`, which never occurs, so authorisation was riding on a fallback
path.

#### 0.2.4

**Breaking: nothing is pushed until your own instruction contains the word `beacon`.** Every
push is gated on that one literal word, checked by the plugin rather than judged by the agent,
and the authorisation expires when the task ends. While you are at the keyboard a phone
notification is noise, and the plugin cannot tell whether you have stepped away — only you can,
so it no longer guesses. **Upgrading silences the plugin until you name the word for a task.**
See [Watching a task](#watching-a-task).

A watch opens when you name that word, and closes by itself when the task ends, which is when
the agent hands control back. Answering a decision mid-task does not end it: the agent is still
working, it just needs you first.

A failure is pushed **before** the watch closes. That order is the whole point: a task that
broke is exactly what you stepped away from, and a close that ran first would swallow it.

The tool can open a watch and report; it can never close one. A model that decided to stop
notifying you would leave you waiting in silence, so closing is reserved for you.

The literal check replaced an earlier version of this release that left the decision to the
agent. That version was not good enough: in a session whose instruction was merely "simulate an
interactive long task", the agent reasoned that the task was about testing this plugin, armed
reporting by itself, and sent four notifications nobody had asked for. A rule the agent can
reason its way around is not a rule, so the test moved into the plugin.

A `systemPrompt` section carries the other half of the rule — that the agent must not raise the
subject unprompted, including in prose on a turn where it decided not to call the tool at all.
That failure was observed: the agent reasoned "the user didn't mention beacon this time, so I
won't bring it up", and then opened its reply with exactly that sentence.

The `/beacon` command is disabled: a command bypasses the recognition this rule rests on.

#### 0.2.3

Messages are sent as **interactive cards** by default: a coloured header that names the
event, a quiet metadata line, and a rule before the body. The colour is the point — a
failed turn is red, a decision orange, done green, progress blue — so you know what a
notification is before reading it.

The new **Message format** setting selects `card` or `text`. `text` restores the old plain
output. **A refused card falls back to text**, so a group that does not accept cards still
receives every message; `Send test` reports when that happens.

**Max characters** now defaults to `3000` (was `1800`), because a card carries more before
it stops being readable on a phone.

Card bodies are markdown, so the model's own punctuation is escaped — an unbalanced `**` in
a milestone would otherwise swallow the rest of the message.

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
