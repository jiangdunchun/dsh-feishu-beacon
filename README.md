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
have stepped away — so the agent reads that from your instruction. Silence is the default,
and messages go out only while a *watch* is open on the work in front of you. See
[Watching a task](#watching-a-task).

## Watching a task

A watch is you saying "I am leaving this running; tell me what happens". It opens when the
agent recognises that request in your instruction, and closes by itself when the task is
over, so you never have to remember to turn notifications off.

**Ask in your own words. There is no keyword to remember:**

> keep me posted while you work through this
> I am stepping out — tell me how it goes
> ping me as each step lands

The agent reads that request out of your instruction and opens the watch with its first
message. Things that merely *look* like a request are not one:

| Not a request | Why |
|---|---|
| "simulate an interactive long task" | A task looking long is not a request |
| "fix the dsh-feishu-beacon plugin" | Naming the plugin is talking about the tool, not asking to be told about this work |
| a task on a workspace that uses this plugin | The workspace is not your instruction |
| "continue with what we did before" | An earlier request authorised an earlier task, not this one |

Reading that intent is the agent's job, and the plugin no longer tries to do it by keyword.
It used to: an earlier release required the literal word `beacon` in your instruction, and
that test failed in both directions at once — the word sits inside this package's own name,
so *"fix the dsh-feishu-beacon plugin"* authorised a notification, while no mechanism could
tell that mention apart from a request.

What the plugin enforces is the **consequence**: a watch covers one turn, it is the only
thing that lets a message out, and the switches in the settings page outrank it.

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
agent has to recognise that you asked to be kept informed and open one. That is also why a
later instruction in the same turn does not close it — the turn boundary is the only close,
and the agent cannot end reporting mid-task either.

### One task, one authorisation

A watch covers **one task — the work the agent does before it hands control back**. Your next
instruction starts from silence, even if the previous task never reported that it finished, so
you can never be left receiving notifications because a watch outlived the request that opened
it. Ask again — in your own words — for the next task.

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

Milestone reporting is the agent's decision, so it needs to be asked once — in your own words:

> I'm stepping out; keep me posted while you work through this

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
Start with the likely answer: nothing was asked for. Reporting is silent until the agent
recognises a request to be kept informed in your instruction, and it stops when the task
ends — so a task you never asked about reports nothing, by design, and one that merely
mentions this plugin reports nothing either. Check, in order: did you actually ask to be
kept posted? Then, should you have been told at all — a run that succeeds sends nothing.
Then the **Enabled** and the relevant **Notify on…** switches. And if a run failed while
reporting was open and you still heard nothing, the push itself failed: the harness log will
carry a warning, never an error, because a failed notification must not break your session.

**The agent says it cannot report without a watch.**
That is the plugin refusing a push on a turn where no watch was opened. It is not asking you
to rephrase: if you want reports, say so in your own words.

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

Design notes, layout, the test suite, and the changelog live in
[README.dev.md](README.dev.md) — English only, because it is read by whoever is working on
the plugin rather than by whoever is installing it.

## License

MIT
