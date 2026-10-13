# dsh-feishu-beacon — developer notes

The plugin as a user sees it is [README.md](README.md), with a Chinese translation in
[README.zh.md](README.zh.md). This file is about building the plugin itself.

## Layout

The repository root **is** the package:

```text
dsh-feishu-beacon/
├── package.json          exports / files / dsh.bundle / dsh.client
├── cordis.patch.yml      the bundle mount row and the composition config base
├── README.md             user-facing: what it does, how to install and ask for it
├── README.zh.md          the Chinese translation of README.md
├── README.dev.md         this file: npm ships every README* it finds
├── lib/
│   ├── index.js          host half: transport, event layer, tool, Config, routes
│   └── client.js         client half: the settings section
└── test/
    ├── smoke.mjs              host smoke test
    ├── client-smoke.mjs       client contract test
    ├── no-cjk.mjs             the zero-CJK enforcement test
    ├── watch-lifecycle.mjs    the push gate: who may be notified, and for how long
    ├── prompt-section.mjs     the system-prompt section, against the real service
    ├── cordis-mount.mjs       real-registry mount check
    ├── install-load.mjs       installed-profile load check
    ├── live-contract.mjs      running-harness contract check
    ├── pack-install-check.mjs publish-list packaging check
    ├── profile-check.mjs      composed-profile acceptance check
    └── live-check.mjs         one-shot real-webhook check (not published)
```

Only `lib/`, `cordis.patch.yml`, the three READMEs, and `LICENSE` ship; everything under
`test/` stays in the repository. The manifest's `files` list does not name `README.dev.md` —
npm ships every `README*` it finds — so `.github/workflows/ci.yml` asserts the tarball's file
set including it. Verify with `npm pack --dry-run`.

Every user-visible and model-visible string lives in a `MESSAGES` block in each half, so
translating or making a label configurable touches one place.

## How it works

Two layers, and both are load-bearing:

- **The tool layer.** Only the model can tell "a test just passed" from "the architecture is
  settled", so milestone reporting is a tool, `dsh_beacon`, that the model calls
  deliberately. Its parameters are `message` and an optional `kind`
  (`plan`/`progress`/`done`), plus the `watch: true` on the first call that authorises the
  turn. A `decision` is deliberately *not* one of its kinds: the event layer already notifies
  that moment, so the tool refuses the call rather than letting two layers send one card.
- **The event layer.** A tool only fires if the model remembers, and `ask_user_question`,
  `approval/asked`, and a failed `turn/end` are exactly the moments a user has to come
  back. Those three are pushed by session events regardless.

The plugin exports a `Config` schema and writes edits through `ctx.settings.update`; the
Loader resolves this row's config against that schema and hands it to `apply`, re-running
`apply` after every edit. Fields are `.volatile()` when the settings page should ask about
them; `format` deliberately is not, because a refused card already falls back to text on its
own. Configuration has two layers, later wins: the `config:` block in `cordis.patch.yml`,
then this row's `config:` in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`.

Two HTTP routes serve the settings section:
`/api/dsh-feishu-beacon/config` (`GET` a redacted view, `POST` a patch) and
`/api/dsh-feishu-beacon/test` (`POST` one test message). The `POST` body is a settings
patch: plain fields merge, `clearWebhook` / `clearSecret` unset a stored credential, and an
empty credential string means "keep the stored value".

Authorisation is the **agent's own `watch: true` call**, and the plugin enforces its
*consequence* rather than re-reading anyone's wording: `lib/index.js` folds two facts out of
the session log — whether a watch was recorded, and which turn it was recorded in. The plugin
never reads the user's message; deciding that a request was made is the agent's job, and the
prompt says so, including that this package's own name is not one.

An earlier release tested the user's instruction for a literal trigger word instead. That
test was wrong in both directions at once: the word sits inside `dsh-feishu-beacon`, so
"fix the dsh-feishu-beacon plugin" authorised a notification, while no mechanism could tell
that mention apart from a request. It is gone; what remains is the turn-scoped watch.

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

## Working on it

```powershell
npm install --ignore-scripts --cache .npm-cache

npm test                      # no-cjk, smoke, client-smoke, watch-lifecycle
npm run test:prompt           # the naming rule reaches every assembled prompt
node test/cordis-mount.mjs web   # a real Cordis registry mounts and re-applies the export
node test/install-load.mjs web   # the installed profile link resolves and applies
node test/pack-install-check.mjs # the published file set composes into a profile
node test/profile-check.mjs web  # the profile composes this plugin as a bundle
node test/live-contract.mjs      # a running harness serves the documented contract
```

`npm run check` is the syntax gate. `npm pack --dry-run` is the packaging check;
`test/pack-install-check.mjs` goes further and composes a throwaway profile from only the
files the manifest publishes.

`test/cordis-mount.mjs` is the one that pins the plugin *shape*: it mounts the package's
export through an actual `Context`, and also mounts the pre-0.2 shape — the one that called
`ctx.settings.register` — requiring that to fail, so the check cannot quietly stop testing
anything.

## Publishing

Publishing from `.github/workflows/publish.yml` uses npm **trusted publishing** (OIDC): no
long-lived token exists for this repository, and npm verifies the workflow's short-lived
identity against the trusted publisher configured on the package page. Dispatch that
workflow manually, with its dry-run input if you only want to see the tarball.

If you publish by hand instead, note two traps:

- a staged version **blocks** a direct publish of the same version number, and clearing the
  stage needs a WebAuthn security key. Bump the version instead.
- npm's registry can take several minutes to make a new version visible. A successful
  publish that `npm view` cannot see yet is not a failure — check again.

## Changes

### 0.2.5

**Reporting is the agent's decision again, and the keyword is gone.** An instruction no longer
has to contain the word `beacon`; the agent reads whether you asked to be kept informed, in
whatever words you used, and opens the watch with its first message. The literal test it
replaces failed in both directions at once — the word sits inside this package's own name, so
*"fix the dsh-feishu-beacon plugin"* authorised a notification, while no mechanism could tell
that mention apart from a request. What the plugin still enforces is the consequence: a watch
covers one turn, it is the only thing that lets a message out, and the settings switches
outrank it. The tool refuses any call that needs a watch without one, so silence stays the
default. See [Watching a task](#watching-a-task).

Two consequences worth stating. The plugin **never reads your message**, so authorisation no
longer depends on any event name or on a queued prompt being recognised. And a later
instruction in the same turn **cannot** close a watch — the turn boundary is the only close,
and the agent cannot end reporting mid-task either.

Also in this release: a `DECISION` card no longer closes with a line telling you to come back
to your computer — the header and the `Answer needed` lead already said it — so the card ends
with the last option. And the developer notes moved out of the user-facing READMEs into
[README.dev.md](README.dev.md), which is this file.

### 0.2.4

**Breaking: nothing is pushed until your own instruction contains the word `beacon`.** Every
push is gated on that one literal word, checked by the plugin rather than judged by the agent,
and the authorisation expires when the task ends. While you are at the keyboard a phone
notification is noise, and the plugin cannot tell whether you have stepped away — only you can,
so it no longer guesses. **Upgrading silences the plugin until you name the word for a task.**
See [Watching a task](#watching-a-task).

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

### 0.2.3

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

### 0.2.2

Documentation only; no behaviour changed.

The README was rewritten for the person installing the plugin rather than for someone
reading the source: what lands on your phone, the four setup steps, what each setting means,
troubleshooting, and uninstalling. Developer material moved to the end.

`README.zh.md` is a full Chinese translation, cross-linked from both files.

The setup step now links Feishu's own custom-bot guide, so the Feishu side is documented by
the people who own it.

### 0.2.1

The release that reaches npm. Its content is identical to the `0.2.0` described below; the
version number moved because `0.2.0` was staged on npm, and a direct publish is refused
over a staged version while clearing the stage needs a WebAuthn security key. Renumbering
is the way out that needs no security key. `0.2.0` is therefore not published and never
will be — do not read its absence as a withdrawn release.

### 0.2.0 — requires dsh 0.2

**Breaking: this release does not load on dsh 0.1.x, and 0.1.1 does not load on 0.2.** The
host half used to take its configuration from `ctx.settings.register`, which 0.2.0 removed;
it now exports a `Config` schema and writes through `ctx.settings.update`.

The pushed message lost its package-name prefix: the first line is the title alone. `Send
test` now assembles through the same function a milestone does, so the prefix and the
length budget apply to it too.

The settings page was rebuilt on the settings design system: every on/off variable is a
switch, every edit applies itself, and `Send test` is the only button.

### 0.1.1

Initial published release: the `dsh_beacon` tool, the three event hooks, the redacted
settings section, and the two HTTP routes, verified against dsh `0.1.5-rc.2`.

### Compatibility

Verified against dsh `0.2.0-rc.2`. dsh is a developer preview and promises breaking
changes, so read that as the version this plugin's host-half contracts were read from, not
as a compatibility promise for later releases.
