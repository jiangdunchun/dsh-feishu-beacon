/**
 * dsh-feishu-beacon — Host half.
 *
 * Two layers, and both are load-bearing:
 *
 * 1. The `dsh_beacon` tool. Only the model can tell "a test just passed" from
 *    "the architecture is settled", so milestone reporting is a tool the model
 *    calls deliberately.
 * 2. Session-event hooks. A model that forgets to call a tool is not a
 *    hypothetical: `ask_user_question`, an approval request, and a failed turn
 *    are exactly the moments a user must be reached, so they are pushed by the
 *    event layer whether or not the model remembers anything.
 *
 * Transport is a Feishu (Lark) custom-bot webhook only: one HTTPS POST, no
 * long connection, no self-built app, no event subscription, no public address.
 *
 * @module dsh-feishu-beacon
 */

import { createHmac } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Stable Loader identity. */
const name = "dsh-feishu-beacon";

/**
 * Services required by the host half.
 *
 * `settings` is the 0.2 settings service. The plugin does not own a
 * configuration scope: the Loader resolves this row's config against
 * {@link Config} and hands it to {@link apply}, and edits go back through
 * `ctx.settings.update`.
 */
// `commands` is deliberately absent: the `/beacon` command is disabled, because a
// command is read without the user's own instruction being recognised, which is the
// one thing the push gate rests on. Declaring a service that is no longer used would
// also make cordis refuse to activate this row.
const inject = ["tools", "workspaceRegistry", "settings", "webServer", "systemPrompt"];

/**
 * Where the naming rule sits in the assembled system prompt.
 *
 * Between the file-reference section (900) and the first per-tool section (1000):
 * the rule is about how this plugin's tool may be talked about, so it belongs with
 * the tool guidance and before the tools themselves.
 */
const BEACON_RULE_ORDER = 950;

/** The section's unique name, which a scoped contribution would shadow. */
const BEACON_RULE_SECTION = "dsh-feishu-beacon:naming-rule";

/**
 * Route prefix the settings page talks to.
 *
 * Derived from {@link name} rather than written out again: the package name is
 * also the settings entry id the configuration is addressed by, and a second
 * literal is a second thing to keep in step.
 */
const ROUTE_BASE = `/api/${name}`;

/** Longest request body accepted on the config route. */
const MAX_REQUEST_BYTES = 65536;

/** Per-field truncation budgets for pushed event content. */
const REASON_CHARS = 300;
const ERROR_CHARS = 500;
const QUESTION_CHARS = 500;
const OPTION_CHARS = 300;

/** Dedupe table size before it is dropped wholesale. */
const DEDUPE_LIMIT = 500;

/**
 * The session event this plugin records a task watch in.
 *
 * A watch means "the user has stepped away and wants this task reported". It is
 * recorded on the session rather than held in memory so it is durable and reads
 * back consistently after a resume. It is a log-only event with an empty payload:
 * everything that matters is the event type and where it sits in the log.
 *
 * There is deliberately no matching "watch closed" event. The close would have to
 * be appended from the observer of `turn/end`, and dsh refuses an append made
 * while another append is being published ("session append cannot reenter while
 * another append is being published"), so the recorded close never landed. The
 * consequence was not a missing log line: the watch stayed open past its turn,
 * the tool then declined to arm a new one because it saw a watch on the session,
 * and every later turn was refused as unauthorised. The turn boundary IS the
 * close, and {@link watchCoversTurn} is where it is read.
 */
const WATCH_EVENT = "beacon/watch";

/**
 * There is deliberately no test on the user's own wording.
 *
 * The authorisation is the model's `watch: true` call, recorded as
 * {@link WATCH_EVENT} and expired at the turn boundary. An earlier release tested
 * the user's instruction for a literal trigger word instead, and that test was
 * wrong in both directions at once: the word sits inside this package's own name,
 * so "fix the dsh-feishu-beacon plugin" authorised a notification, and no
 * mechanism could tell that mention apart from a request. Reading the user's
 * intent is the model's job; the plugin's job is to hold the consequence to one
 * turn, and to keep the switches in force.
 */

/**
 * Read every state the push gate depends on, in one pass.
 *
 * The log is scanned backwards once rather than once per fact: a session that has
 * been open all day carries thousands of events, and the gate is consulted on every
 * milestone and every question, so a handful of full scans per push is the kind of
 * cost that only shows up in the sessions that matter most.
 *
 * @param session - the session to read.
 * @returns the current turn, and what is in force for it.
 */
function readState(session) {
  const events = sessionEvents(session);
  const state = {
    turn: undefined,
    taskWatch: undefined
  };
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const type = event?.type;
    if (type === "turn/start" && state.turn === undefined) {
      if (typeof event.data?.turn === "number") state.turn = event.data.turn;
      continue;
    }
    if (state.taskWatch === undefined && type === WATCH_EVENT) {
      state.taskWatch = nearestTurnBefore(events, i) ?? null;
      continue;
    }
    if (state.turn !== undefined && state.taskWatch !== undefined) break;
  }
  return state;
}

/** The turn number of the last `turn/start` at or before an index, if any. */
function nearestTurnBefore(events, index) {
  for (let i = index; i >= 0; i -= 1) {
    if (events[i]?.type === "turn/start" && typeof events[i].data?.turn === "number") return events[i].data.turn;
  }
  return undefined;
}

/**
 * Whether the watch recorded on a session covers the turn running now.
 *
 * A watch authorises one task, and a task is a turn: the next instruction starts
 * unarmed. Reading the expiry off the log position is what lets the authorisation
 * end without anything having to write to the log when a turn ends — which is
 * just as well, because dsh rejects an append made from inside an append, so that
 * write could never have happened from the `turn/end` observer.
 *
 * @param state - the state {@link readState} returned for the session.
 * @returns whether a push is covered by the watch.
 */
function watchCoversTurn(state) {
  return state.taskWatch !== undefined && state.taskWatch !== null && state.taskWatch === state.turn;
}

/**
 * Every user-visible and model-visible string in one block, so wiring a
 * translation or making a label configurable touches exactly one place.
 */
const MESSAGES = {
  toolDescription:
    "Push a progress message to the user's phone (Feishu) through dsh-feishu-beacon, and open "
    + "reporting for the work in front of you. "
    + "Whether the user wants that is your call to read, and it is a call about what they asked for: "
    + "call it with watch=true when their own instruction asks to be kept informed about this task. "
    + "They may say it in any words, and they may not say it at all - nothing is pushed until that "
    + "first call opens a watch. "
    + "Read that request from what they wrote; do not manufacture one. A task looking long is not a "
    + "request, this workspace being the plugin itself is not a request, and an earlier conversation "
    + "having used this tool is not a request. An instruction that only names dsh-feishu-beacon - "
    + "editing the plugin, reading its code, discussing its behaviour - is someone talking about the "
    + "tool, not asking to be told about this piece of work. "
    + "Do not ask the user whether they want notifications, do not offer them as an option or a "
    + "checkbox in a question, and do not mention that reporting is off: someone who wanted it has "
    + "said so, and someone who did not has not asked. If they did not ask, do the work silently. "
    + "When they have asked, call it once with watch=true and make that first message the plan: the "
    + "whole task and how many steps it has, in one go. Reporting then lasts until the turn ends, "
    + "which is when the task the user asked about is over. "
    + "This tool sends three kinds, and they are the whole vocabulary it has: "
    + "plan - the task is broken down: state the whole task and how many steps it has, in one go; "
    + "progress - a step named in the plan is finished: say what was completed and what it produced "
    + "or concluded, and number it against the plan (\"n/N\", N being the step count the plan card "
    + "gave); "
    + "done - every step named in the plan is finished: state what was delivered. "
    + "Those are labels, not a quota. A plan of eight steps normally produces about six progress "
    + "cards - one per finished step - and that cadence is what this tool exists for, not chatter. "
    + "The first step is the plan card and the last is the done card, so every step in between gets "
    + "its own progress card as it finishes. "
    + "A decision is not sent from here. When the user has to act at their computer - they must "
    + "choose something, or a command needs an authorisation you do not have - ask with "
    + "ask_user_question, or let the authorisation be asked: that moment is notified on its own, and "
    + "this tool refuses to send a decision card. Never settle a decision that needs the user by "
    + "yourself instead of asking. "
    + "Every call's result reports how much of the plan you have covered so far; keep it matching "
    + "the steps you have finished. "
    + "Never push empty chatter such as \"working on it\". The message must stand alone - the user "
    + "may see only this one message. "
    + "You cannot and must not try to turn reporting off.",
  paramMessage: "The progress text to push. It must stand alone: the user may see only this message.",
  paramKind:
    "The card kind, one of exactly three: plan (the task is broken down), progress (a step named "
    + "in the plan is finished), or done (every step is finished). Defaults to progress. A decision "
    + "is not a kind this tool sends - it is notified automatically when the question or the "
    + "authorisation is asked, and the tool refuses the call.",
  paramWatch:
    "Set true on the first call for a task, and only when the user's own instruction asked to be "
    + "kept informed about it. That call is what opens reporting, and the tool refuses any call that "
    + "needs a watch without one. It covers the rest of the turn, which then also includes "
    + "questions, authorization requests, and failures - those are notified on their own, so do not "
    + "send a card for them from here.",
  outputPushed: (kind) => `Pushed (${kind})`,
  decisionNotFromTool:
    "dsh-feishu-beacon does not send decision cards from the tool. A question or an approval "
    + "request is notified automatically when it is asked, so there is nothing to send here: ask "
    + "with ask_user_question (or let the authorisation be asked) and send plan, progress, or done "
    + "from this tool.",
  coverageNote: (sent, completed, total) =>
    `Plan coverage so far this turn: ${String(sent)} progress card(s) sent, `
    + `${String(completed)} of ${String(total)} steps marked completed. `
    + "Every step between the first and the last expects its own progress card as it finishes.",
  noAgentSession: "dsh_beacon requires an agent Session",
  disabled: "dsh-feishu-beacon is disabled (enabled: false); the message was not pushed",
  notConfigured:
    "dsh-feishu-beacon has no webhookUrl configured; set it in Settings > Feishu beacon, then retry",
  // The four card kinds, and the only four labels a pushed card's header can carry.
  // Everything the event layer sends is rendered as one of them; `leads` below is
  // how it says which of the four it is.
  kindLabels: {
    plan: "PLAN",
    progress: "PROGRESS",
    decision: "DECISION",
    done: "DONE"
  },
  // The first line of an event push's body. The header is the kind alone, so this is
  // what tells a question apart from an approval request once the card is open - and
  // both are decisions, because both need the user at their computer.
  leads: {
    question: "Answer needed",
    approval: "Authorization needed"
  },
  titles: {
    error: "Turn failed"
  },
  task: "Task",
  workspace: "Workspace",
  time: "Time",
  openAt: "Open at",
  tool: "tool",
  reason: "reason",
  multiSelect: "[multi-select]",
  questionFooter: "Back to your computer to handle this.",
  unknownTool: "(unknown tool)",
  noReason: "(no reason given)",
  unknownError: "Unknown error",
  testTitle: "TEST",
  testBody: "dsh-feishu-beacon test message. The webhook is reachable and the signature (if set) is accepted.",
  configSent: "Configuration saved",
  testSent: "Test message sent",
  testSentText: "Test message sent, but as plain text:",
  cardRefused:
    "this group did not accept an interactive card, so messages will arrive as plain text.",
  testFailed: "Test message failed",
  webhookRequired: "webhookUrl is required",
  webhookMustBeHttps: "webhookUrl must be an https:// URL",
  secretMustBeString: "secret must be a string",
  notFound: "Not found",
  methodNotAllowed: "Method not allowed",
  badRequest: "Malformed request body",
  bodyTooLarge: "Request body is too large",
  deliveryFailed: "Feishu rejected the message",
  emptyMessage: "dsh_beacon requires a non-empty message",
  watchNeedsRequest:
    "dsh-feishu-beacon refuses to push: no watch covers this turn, and this call did not ask for "
    + "one. Opening a watch is the first call for a task, made with watch=true, and only when the "
    + "user's own instruction asked to be kept informed. If they did, call it again with watch=true; "
    + "if they did not, continue the task silently. Do not ask the user whether they want "
    + "notifications, do not offer them as an option or a checkbox in a question, and do not "
    + "mention this refusal again.",
  ignoredNoWatch:
    "dsh-feishu-beacon pushed nothing: reporting is off for this turn, because the watch could not "
    + "be opened or has already expired with an earlier turn. Open one with watch=true if the "
    + "current instruction asks to be kept informed, and otherwise continue silently."
};

/**
 * The one rule that has to be in force on every turn, not only when a tool is called.
 *
 * Why this is a prompt section rather than another line in the tool description: the
 * description is read while deciding whether to *call* the tool, and a model that has
 * already decided not to call it can still mention the subject in prose. That is
 * exactly what happened — in a session whose third instruction omitted the trigger
 * word, the agent reasoned "the user didn't mention beacon this time, so I won't use
 * that tool or bring it up", and then wrote "this time it does not involve beacon
 * pushes" in the reply. The tool was never called, so no refusal fired, so nothing
 * that carries a prohibition was ever delivered. A section is delivered every turn.
 *
 * The wording targets the observed cause: a previous turn in the same conversation
 * having used the trigger is what made the omission worth narrating. Naming that case
 * is the point — a generic "do not mention it" was already in the tool description and
 * was not enough.
 */
const NAMING_RULE = [
  "Naming rule for dsh-feishu-beacon.",
  "The word \"beacon\" belongs to the user. Do not write it in your own replies unless the",
  "user's current instruction contains it.",
  "This includes explaining, confirming, or reassuring: never say that a task \"does not involve",
  "beacon\", never say reporting is off or that no notification will be sent, and never offer",
  "beacon as a choice, option, or checkbox.",
  "The case to watch for is a conversation where an earlier instruction contained the word and",
  "the current one does not. Say nothing about the change. The user knows what they asked for;",
  "silently do the work.",
  "If the current instruction does contain the word, act on it - the rule is about not raising",
  "the subject unprompted, not about avoiding the tool."
].join(" ");

/**
 * Resolved plugin configuration.
 *
 * A field is `.volatile()` when it is a question the settings page should ask:
 * the service only offers a form for an entry that has at least one volatile
 * field, and only volatile fields are editable there. `apply` is re-run with a
 * freshly resolved config after each edit, so reading the values through
 * {@link fieldValue} is always reading the live configuration.
 *
 * Fields left non-volatile are still readable configuration — `format` is the
 * one, kept for the operator who wants to change it on the row rather than in a
 * form nobody should have to answer.
 *
 * Both credentials carry `role("secret")`, so the settings service strips them
 * from every wire-facing view and a reader only ever learns whether a value is
 * stored.
 */
const Config = z.object({
  webhookUrl: z.string().role("secret").volatile().default(""),
  secret: z.string().role("secret").volatile().default(""),
  enabled: z.boolean().volatile().default(true),
  prefix: z.string().volatile().default(""),
  notifyQuestion: z.boolean().volatile().default(true),
  notifyApproval: z.boolean().volatile().default(true),
  notifyError: z.boolean().volatile().default(true),
  maxChars: z.number().volatile().default(3000),
  // Deliberately NOT `.volatile()`: the settings form is generated from the
  // volatile fields, and this one is not a question worth asking. A refused card
  // already falls back to text on its own, so choosing the format by hand only
  // removes the attempt. It stays a field so anyone who wants no card attempt at
  // all can still set `format: text` on the row, and so the budget below keeps
  // its source.
  format: z.string().default("card"),
  publicUrl: z.string().volatile().default("")
});

/**
 * The configuration the plugin row is currently resolved against.
 *
 * `apply` runs again after every settings edit, and that re-run is what puts the
 * new values here. The settings routes read this rather than their own captured
 * `config`, because a route writes and then answers in the same request: without
 * the indirection the response would describe the configuration from *before*
 * the write.
 */
let configRef;

/**
 * The fields the plugin reads through {@link configRef}.
 *
 * Every accessor is a function so it is evaluated per read, which is the whole
 * point: a captured value would be the value at `apply` time.
 */
const liveConfig = {
  text(key, fallback) {
    const value = fieldValue(configRef, key, fallback);
    return typeof value === "string" ? value : fallback;
  },
  positiveInt(key, fallback) {
    const value = fieldValue(configRef, key, fallback);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  },
  flags() {
    return {
      enabled: fieldValue(configRef, "enabled", true) !== false,
      notifyQuestion: fieldValue(configRef, "notifyQuestion", true) !== false,
      notifyApproval: fieldValue(configRef, "notifyApproval", true) !== false,
      notifyError: fieldValue(configRef, "notifyError", true) !== false
    };
  }
};

/**
 * Read one configuration field.
 *
 * A `.volatile()` field arrives as a live cell rather than a plain value, so
 * the cell is unwrapped when it is one. Everything that reads configuration
 * goes through here, which is what keeps "the resolved config" and "the config
 * the settings page just wrote" the same thing.
 *
 * @param config - the resolved configuration object.
 * @param key - the field to read.
 * @param fallback - the value to use when the field is absent.
 * @returns the field's current value, or the fallback.
 */
function fieldValue(config, key, fallback) {
  const field = config?.[key];
  if (field === undefined || field === null) return fallback;
  const value = typeof field.get === "function" ? field.get() : field;
  return value === undefined || value === null ? fallback : value;
}

/**
 * Sign a Feishu custom-bot request.
 *
 * Feishu's scheme is specific: the string to sign is `timestamp\nsecret`, the
 * HMAC-SHA256 key is that whole string, the message is EMPTY, and the digest is
 * base64. Enterprise WeChat and DingTalk use different envelopes, success codes,
 * and signing schemes, and a mismatched success code fails silently - the
 * message is dropped while the sender believes it succeeded.
 *
 * @param timestamp - seconds since the epoch, as a string.
 * @param secret - the bot's signing secret.
 * @returns the base64 signature to send as the `sign` query parameter.
 */
function feishuSign(timestamp, secret) {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

/**
 * POST one payload to a Feishu custom-bot webhook.
 *
 * The success code is read leniently: a generic endpoint may answer without one,
 * and a missing code is not a failure. A present numeric non-zero code is.
 *
 * @param webhookUrl - the bot webhook URL.
 * @param payload - the message payload to POST.
 * @param options - optional signing secret and abort signal.
 * @returns the parsed response body.
 * @throws when the endpoint rejects the message or the transport fails.
 */
async function postFeishu(webhookUrl, payload, options = {}) {
  let url = webhookUrl;
  if (typeof options.secret === "string" && options.secret.length > 0) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = feishuSign(timestamp, options.secret);
    const glue = url.includes("?") ? "&" : "?";
    url += `${glue}timestamp=${encodeURIComponent(timestamp)}&sign=${encodeURIComponent(sign)}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    ...options.signal === undefined ? {} : { signal: options.signal }
  });
  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    throw new Error(`${MESSAGES.deliveryFailed}: HTTP ${String(response.status)} ${raw.slice(0, 200)}`);
  }
  const code = json?.code ?? json?.StatusCode;
  if (typeof code === "number" && code !== 0) {
    const detail = json?.msg ?? json?.StatusMessage ?? raw.slice(0, 200);
    throw new Error(`${MESSAGES.deliveryFailed}: code ${String(code)} ${String(detail)}`);
  }
  return json;
}

/**
 * Deliver one push, preferring the card and falling back to text.
 *
 * A card is a different `msg_type`, and whether a given bot or group accepts one
 * is not something the sender can know in advance. Failing over keeps the
 * promise the whole plugin rests on — that a human-attention moment arrives —
 * instead of trading it for nicer formatting. The refusal is reported to the
 * caller so it can say so, rather than leaving a user to wonder why their
 * messages look plain.
 *
 * @param webhookUrl - the bot webhook URL.
 * @param payloads - `text` (always deliverable) and an optional `card`.
 * @param options - optional signing secret and abort signal.
 * @returns whether a card was tried and whether it was accepted.
 * @throws when no payload is accepted.
 */
async function sendFeishu(webhookUrl, payloads, options = {}) {
  const { text, card } = payloads;
  const secrets = {
    secret: options.secret,
    ...options.signal === undefined ? {} : { signal: options.signal }
  };
  if (card === undefined) {
    await postFeishu(webhookUrl, text, secrets);
    return { cardTried: false, cardAccepted: false };
  }
  try {
    await postFeishu(webhookUrl, card, secrets);
    return { cardTried: true, cardAccepted: true };
  } catch (error) {
    // Only a rejection of the *message* falls back: a transport failure is not a
    // format problem, and resending the same bytes as text would fail the same
    // way while hiding the real reason.
    const refused = /^Feishu rejected the message/.test(String(error?.message ?? ""));
    if (!refused) throw error;
    await postFeishu(webhookUrl, text, secrets);
    return { cardTried: true, cardAccepted: false, cardError: String(error?.message ?? error) };
  }
}

/** Cut one field to its budget, marking the cut with an ellipsis. */
function clip(value, limit) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

/** Render a local timestamp without depending on the host locale. */
function stamp(date = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Last path segment of a directory, tolerating both separators and trailing ones. */
function dirName(path) {
  if (typeof path !== "string" || path.length === 0) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Read a session's events.
 *
 * `session.events` is the documented array; the live Session class exposes the
 * same log through `snapshotEvents()`, so both are accepted and an empty array
 * is the safe answer when neither exists.
 *
 * @param session - the session whose log is read.
 * @returns the events in log order.
 */
function sessionEvents(session) {
  if (Array.isArray(session?.events)) return session.events;
  if (typeof session?.snapshotEvents === "function") {
    const events = session.snapshotEvents();
    if (Array.isArray(events)) return events;
  }
  return [];
}

/** Latest `session/title` text, or an empty string. */
function sessionTitle(session) {
  const events = sessionEvents(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "session/title" && typeof event.data?.title === "string") return event.data.title;
  }
  return "";
}

/** How many characters a message may spend when the format is a card. */
const CARD_MAX_CHARS = 3000;

/**
 * Escape the markdown characters a card would otherwise interpret.
 *
 * A milestone body is the model's own text and routinely contains `*`, `_`, or
 * backticks. In a text push those are literal; in a card they are markup, so an
 * unbalanced `**` would swallow the rest of the message. Only what lark_md acts
 * on is escaped, so ordinary punctuation still reads normally.
 *
 * @param value - the text to escape.
 * @returns the text with markdown metacharacters neutralized.
 */
function escapeMarkdown(value) {
  return String(value ?? "").replace(/([\\*_~`\[\]])/g, "\\$1");
}

/**
 * The three parts every push is made of, before a format renders them.
 *
 * Both formats build from here so the title, the metadata lines, and the length
 * budget cannot drift apart between a card and a plain-text push — which is the
 * failure the previous two assemblers had.
 *
 * @param options - configuration snapshot and content.
 * @returns the title, the metadata lines, the body, and the resolved budget.
 */
function messageParts(options) {
  const { config, kindLabel, title, body, url } = options;
  const task = typeof options.task === "string" ? options.task : "";
  const workspace = typeof options.workspace === "string" ? options.workspace : "";
  const content = typeof body === "string" ? body : "";
  const configuredPrefix = fieldValue(config, "prefix", "");
  const prefix = typeof configuredPrefix === "string" && configuredPrefix.length > 0 ? `${configuredPrefix} ` : "";
  // The milestone pushes carry no title of their own, so they fall back to the
  // bare kind label. The package name is deliberately not part of it: the reader
  // already knows which bot sent the message, and repeating it costs the first
  // line that the summary belongs on. A caller that wants one uses `prefix`.
  const head = `${prefix}${title === undefined ? kindLabel : title}`;
  const meta = [];
  if (task.length > 0) meta.push(`${MESSAGES.task}: ${task}`);
  if (workspace.length > 0) meta.push(`${MESSAGES.workspace}: ${workspace}`);
  meta.push(`${MESSAGES.time}: ${stamp()}`);
  if (typeof url === "string" && url.length > 0) meta.push(`${MESSAGES.openAt}: ${url}`);
  // The format decides the *budget*, not what the user sees: a card carries more
  // before it stops being readable on a phone, and the plain-text fallback has to
  // respect the smaller box it lands in. It is deliberately not in the settings
  // form — the card-then-text fallback already removes the need to choose — but it
  // stays configurable for anyone who wants to stop trying cards altogether.
  const format = fieldValue(config, "format", "card") === "text" ? "text" : "card";
  const fallback = format === "card" ? CARD_MAX_CHARS : 1800;
  const budget = fieldValue(config, "maxChars", fallback);
  const maxChars = Number.isSafeInteger(budget) && budget > 0 ? budget : fallback;
  return { head, meta, body: content, maxChars, format };
}

/**
 * The same parts, marked as the plain-text rendering.
 *
 * A refused card is resent as text, and the text keeps the same length budget the
 * card was cut to. Trimming it further at the moment of fallback would silently
 * shorten a message the user is already on their way to read, for no reason they
 * could act on; one budget for the message is the honest rule.
 *
 * @param parts - parts from {@link messageParts}.
 * @returns the same parts, rendered as text.
 */
function asTextParts(parts) {
  return { ...parts, format: "text" };
}

/** Cut a body to what the metadata leaves of the budget. */
function budgetBody(parts) {
  const spent = parts.head.length + parts.meta.join("\n").length + 2;
  const room = Math.max(0, parts.maxChars - spent);
  if (parts.body.length <= room) return parts.body;
  return `${parts.body.slice(0, Math.max(0, room - 3))}...`;
}

/**
 * Assemble the pushed message as plain text.
 *
 * @param options - configuration snapshot and content.
 * @param prepared - parts already computed for this push, when the caller has them.
 * @returns the text to POST.
 */
function buildMessage(options, prepared) {
  const parts = prepared ?? messageParts(options);
  const lines = [parts.head, ...parts.meta, "", parts.body];
  const text = lines.join("\n");
  if (text.length <= parts.maxChars) return text;
  // The budget is spent on the body first: the metadata is short and is what
  // makes the message identifiable at a glance.
  return [parts.head, ...parts.meta, "", budgetBody(parts)].join("\n");
}

/** The header colour for one milestone kind, so the notification is readable at a glance. */
const CARD_TEMPLATES = {
  error: "red",
  decision: "orange",
  done: "green",
  plan: "blue",
  progress: "blue",
  test: "grey"
};

/**
 * Assemble the pushed message as a Feishu interactive card.
 *
 * The header carries the title and its colour, the metadata becomes one quiet
 * block, and the body is separated by a rule so it reads as the content. The
 * card envelope is a different `msg_type`, so this returns the whole payload
 * rather than a string.
 *
 * @param options - configuration snapshot and content.
 * @param prepared - parts already computed for this push, when the caller has them.
 * @returns the card payload to POST.
 */
function buildCard(options, prepared) {
  const parts = prepared ?? messageParts(options);
  const kind = typeof options.templateKey === "string" ? options.templateKey : "progress";
  const template = CARD_TEMPLATES[kind] ?? CARD_TEMPLATES.progress;
  const elements = [];
  if (parts.meta.length > 0) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: parts.meta.map(escapeMarkdown).join("\n") }
    });
    elements.push({ tag: "hr" });
  }
  elements.push({
    tag: "div",
    text: { tag: "lark_md", content: escapeMarkdown(budgetBody(parts)) }
  });
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: parts.head },
        template
      },
      elements
    }
  };
}

/**
 * Assemble one push, in both renderings.
 *
 * Both are built every time so the transport always has a text fallback ready,
 * whether or not a card is the format in force. Building it lazily would mean the
 * one path that runs when a group refuses a card also runs when something is
 * already going wrong; assembling it here keeps that path to a single POST.
 *
 * @param options - configuration snapshot and content.
 * @returns the payload to POST, the fallback payload, and the format in force.
 */
function buildPush(options) {
  const parts = messageParts(options);
  const text = { msg_type: "text", content: { text: buildMessage(options, asTextParts(parts)) } };
  if (parts.format === "text") return { payload: text, text, format: "text", parts };
  return { payload: buildCard(options, parts), text, format: "card", parts };
}

/** Render one `ask_user_question` question with its full option list. */
function renderQuestion(question, index) {
  const lines = [];
  const header = typeof question?.header === "string" && question.header.length > 0 ? `${question.header}: ` : "";
  const multi = question?.multi_select === true ? ` ${MESSAGES.multiSelect}` : "";
  lines.push(`${String(index + 1)}. ${header}${clip(question?.question, QUESTION_CHARS)}${multi}`);
  const options = Array.isArray(question?.options) ? question.options : [];
  for (const option of options) {
    const description = typeof option?.description === "string" && option.description.length > 0
      ? ` - ${clip(option.description, OPTION_CHARS)}`
      : "";
    lines.push(`   - ${clip(option?.label, OPTION_CHARS)}${description}`);
  }
  return lines.join("\n");
}

/** Render the whole `ask_user_question` call. */
function renderQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) return MESSAGES.questionFooter;
  const rendered = list.map((question, index) => renderQuestion(question, index));
  rendered.push("", MESSAGES.questionFooter);
  return rendered.join("\n");
}

/** Send one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

/** Read a JSON request body, bounded by {@link MAX_REQUEST_BYTES}. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error(MESSAGES.bodyTooLarge);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const error = new Error(MESSAGES.badRequest);
      error.statusCode = 400;
      throw error;
    }
    return parsed;
  } catch (cause) {
    if (cause?.statusCode !== undefined) throw cause;
    const error = new Error(MESSAGES.badRequest);
    error.statusCode = 400;
    throw error;
  }
}

/**
 * The host half.
 *
 * @param ctx - host context carrying `tools`, `workspaceRegistry`, `settings`, and `webServer`.
 * @param config - the composition-layer configuration (the bundle's `config:` block).
 */
function apply(ctx, config) {
  /**
   * This row's resolved configuration.
   *
   * The Loader re-runs `apply` with a freshly resolved object after every
   * settings edit, so publishing it here keeps every read — including the one a
   * route makes while answering a write — pointed at the current values.
   */
  configRef = config;

  /** Process-lifetime dedupe of handled event call ids. */
  const seen = new Set();

  /**
   * Whether this session may push right now.
   *
   * One condition: a watch was recorded during the *current* turn. That is the
   * whole authorisation — the model opened it by calling the tool with
   * `watch: true`, and the turn boundary closes it. Reading it here rather than
   * remembering it from the call is what makes the expiry cost nothing: no state
   * has to be written when a turn ends, because the log position is the state.
   *
   * @param session - the session to read.
   * @returns whether a push is authorised.
   */
  const watchAllows = (session) => watchCoversTurn(readState(session));

  /**
   * Record a watch on the session, where every later read can see it.
   *
   * Called from the tool only, never from a `session/event` observer: dsh refuses an
   * append made while another append is being published, and an observer runs inside
   * one. A watch is opened by the tool's own turn, where nothing is mid-append.
   *
   * @param session - the session to record the watch on.
   */
  const recordWatch = (session) => {
    try {
      session.append(WATCH_EVENT, {});
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not record the watch: ${String(error?.message ?? error)}`);
    }
  };

  /**
   * Whether one class of event push should go out.
   *
   * Two independent gates, and both must pass. `watchAllows` is the model's own
   * decision that this task is one the user stepped away from — a watch it opened in
   * this turn — because a user at the keyboard does not need a phone notification.
   * The switches are the deployment's standing policy and outrank the watch: a class
   * switched off stays off however the session is watched.
   *
   * @param session - the session the event belongs to.
   * @param switchName - the configuration switch governing this class.
   * @returns whether to push.
   */
  const pushAllowed = (session, switchName) => {
    const switches = liveConfig.flags();
    if (switches.enabled === false) return false;
    if (switches[switchName] === false) return false;
    return watchAllows(session);
  };

  /** A session id plus event time, used only when an event carries no callId. */
  const fallbackKey = (session, event) => `${String(session?.id ?? "session")}:${String(event?.time ?? "")}`;

  /** Record a key, dropping the whole table once it is full. */
  const remember = (key) => {
    if (seen.size >= DEDUPE_LIMIT) seen.clear();
    seen.add(key);
  };

  /** Workspace display title for a directory, or an empty string. */
  const workspaceTitle = async (cwd) => {
    if (typeof cwd !== "string" || cwd.length === 0) return "";
    try {
      const workspace = await ctx.workspaceRegistry.resolveByPath(cwd);
      if (workspace !== undefined && typeof workspace.title === "string") return workspace.title;
    } catch {
      /* An unknown or unresolvable directory simply falls back to its base name. */
    }
    return "";
  };

  /** Session task name: the logged title, else the session directory's base name. */
  const taskName = (session) => sessionTitle(session) || dirName(session?.header?.cwd);

  /** The URL a user should open, when the deployment exposes one. */
  const openUrl = () => {
    const configured = liveConfig.text("publicUrl", "");
    if (configured.length > 0) return configured;
    const fromEnv = process.env.DSH_WEB_URL;
    return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : "";
  };

  /**
   * How much of this turn's plan the model has actually reported.
   *
   * Both facts come from the log rather than from any counter kept in memory, so
   * they cannot drift from what happened: how many `progress` cards this turn has
   * sent, and the todo list the model itself wrote. Silence is the honest answer
   * when there is no todo list to compare against, and when the two agree.
   *
   * The card this call just pushed is not counted from the log — a caller that
   * reaches `execute` directly never had a `tool/call` event logged for it — so it
   * is skipped by its own call id and added by hand instead.
   *
   * The first step is covered by the plan card and the last by the done card, so a
   * plan of N steps expects N - 2 progress cards once every step is complete.
   *
   * @param session - the session to read.
   * @param kind - the kind this call just sent.
   * @param callId - this call's id, skipped when the log already carries it.
   * @returns the note to append to the tool result, or undefined when covered.
   */
  const planCoverageNote = (session, kind, callId) => {
    const events = sessionEvents(session);
    let prior = 0;
    let todos;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      const type = event?.type;
      if (type === "turn/start") break;
      if (todos === undefined && type === "todo/write" && Array.isArray(event.data?.todos)) {
        todos = event.data.todos;
        continue;
      }
      if (type !== "tool/call" || event.data?.name !== "dsh_beacon") continue;
      if (callId !== undefined && event.data?.callId === callId) continue;
      let args;
      try {
        args = JSON.parse(event.data.arguments ?? "{}");
      } catch {
        continue;
      }
      const sent = typeof args?.kind === "string" ? args.kind : "progress";
      if (sent === "progress") prior += 1;
    }
    if (todos === undefined || todos.length === 0) return undefined;
    const total = todos.length;
    const completed = todos.filter((todo) => todo?.status === "completed").length;
    const sent = prior + (kind === "progress" ? 1 : 0);
    const expected = Math.max(0, completed - 1 - (completed === total ? 1 : 0));
    if (sent >= expected) return undefined;
    return MESSAGES.coverageNote(sent, completed, total);
  };

  /**
   * Assemble and POST one message for a session.
   *
   * @param session - the session the message belongs to.
   * @param content - title, body, and optional URL override.
   * @returns the assembled text that was sent.
   * @throws when the webhook is unconfigured or Feishu rejects the message.
   */
  const push = async (session, content) => {
    const webhookUrl = liveConfig.text("webhookUrl", "");
    if (webhookUrl.length === 0) throw new Error(MESSAGES.notConfigured);
    const cwd = session?.header?.cwd;
    const options = {
      config: configRef,
      kindLabel: MESSAGES.kindLabels[content.kind] ?? MESSAGES.kindLabels.progress,
      title: content.title,
      task: taskName(session),
      workspace: await workspaceTitle(cwd) || dirName(cwd),
      body: content.body,
      url: content.url === false ? "" : openUrl(),
      templateKey: content.kind
    };
    const { payload, text, format } = buildPush(options);
    const secret = liveConfig.text("secret", "");
    const outcome = await sendFeishu(webhookUrl, {
      text,
      ...format === "card" ? { card: payload } : {}
    }, {
      secret,
      ...content.signal === undefined ? {} : { signal: content.signal }
    });
    if (outcome.cardTried && outcome.cardAccepted === false) {
      ctx.logger?.warn?.(`${name}: the card was refused, the message was sent as text instead: ${String(outcome.cardError ?? "")}`);
    }
    return text.content.text;
  };

  /**
   * Push from an event hook. Event delivery must never throw into the session
   * event bus, so every failure is contained and logged.
   */
  const pushQuietly = async (session, content, label) => {
    try {
      await push(session, content);
    } catch (error) {
      ctx.logger?.warn?.(`${name}: ${label} push failed: ${String(error?.message ?? error)}`);
    }
  };

  // The naming rule rides the system prompt so it is in force on every turn, including
  // the turns where the tool is never considered. A missing `systemPrompt` service
  // would mean a composition without a global prompt to augment, which is why the
  // service is injected; registering through an effect gives it the usual disposer.
  ctx.effect(() => ctx.systemPrompt.section({
    name: BEACON_RULE_SECTION,
    order: BEACON_RULE_ORDER,
    // The text is literal: `{{...}}` sequences are not this plugin's to interpret.
    interpolate: false,
    text: NAMING_RULE
  }), `${name}: naming rule`);

  ctx.tools.register(defineTool({
    name: "dsh_beacon",
    description: MESSAGES.toolDescription,
    parameters: {
      message: { type: "string", required: true, description: MESSAGES.paramMessage },
      kind: { type: "string", description: MESSAGES.paramKind },
      watch: { type: "boolean", description: MESSAGES.paramWatch }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", required: true },
          delivered: { type: "boolean", required: true },
          // Present only when the plan's steps and the reported ones disagree, so
          // the happy path keeps the result the callers and tests already know.
          note: { type: "string" }
        }
      },
      render: (_args, value) => value.note === undefined
        ? [{ type: "text", text: MESSAGES.outputPushed(value.kind) }]
        : [
          { type: "text", text: MESSAGES.outputPushed(value.kind) },
          { type: "text", text: value.note }
        ]
    },
    async execute(args, exec) {
      const session = exec.agent?.session;
      if (session === undefined) throw new Error(MESSAGES.noAgentSession);
      if (liveConfig.flags().enabled === false) throw new Error(MESSAGES.disabled);
      const body = typeof args.message === "string" ? args.message.trim() : "";
      if (body.length === 0) throw new Error(MESSAGES.emptyMessage);

      // A deployment with nowhere to push is a configuration problem, and it is
      // reported before the authorisation is even considered: telling the model "the
      // user did not ask for this" while the webhook is missing would send it to fix
      // the wrong thing, and would hide a deployment fault behind a usage refusal.
      if (liveConfig.text("webhookUrl", "").length === 0) throw new Error(MESSAGES.notConfigured);

      const requested = typeof args.kind === "string" ? args.kind : "progress";
      // A decision is the one kind this tool no longer sends. The event layer already
      // notifies it, from the question or the approval itself, and a second card for
      // the same moment is exactly the duplicate this gate removes. It is a refusal
      // and not a silent remap to progress: the caller learns the rule at the call
      // that got it wrong, instead of discovering it on the phone.
      if (requested === "decision") throw new Error(MESSAGES.decisionNotFromTool);
      const kind = Object.hasOwn(MESSAGES.kindLabels, requested) ? requested : "progress";

      // A milestone opens the task scope for the turn it is sent in. The opening is
      // the model's call: it asked with `watch: true`, which is the plugin's whole
      // authorisation, and the turn boundary is where that authorisation ends.
      //
      // The test is "does the turn running now already have a watch", not "has this
      // session ever been watched". A watch opened in an earlier turn is spent, and
      // treating it as current is what used to lock every later turn out: the tool saw
      // a watch, declined to arm one for this turn, and then refused the push because
      // the watch it found was not this turn's.
      if (watchCoversTurn(readState(session)) === false) {
        if (args.watch !== true) throw new Error(MESSAGES.watchNeedsRequest);
        recordWatch(session);
      }
      // Nothing to report against means nothing was pushed. A watch that could not be
      // recorded lands here rather than pushing on a scope that does not exist.
      if (watchAllows(session) === false) throw new Error(MESSAGES.ignoredNoWatch);
      await push(session, { kind, body, signal: exec.signal });
      const note = planCoverageNote(session, kind, exec.callId);
      return note === undefined ? { kind, delivered: true } : { kind, delivered: true, note };
    }
  }));

  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type === "tool/call") {
      if (event.data?.name !== "ask_user_question") return;
      if (pushAllowed(session, "notifyQuestion") === false) return;
      const key = event.data.callId ?? fallbackKey(session, event);
      if (seen.has(key)) return;
      remember(key);
      let parsed;
      try {
        parsed = JSON.parse(event.data.arguments ?? "{}");
      } catch {
        parsed = {};
      }
      // A question is a decision: the user has to come back to their computer to
      // answer it. The header says only that, and the body's first line says which
      // kind of decision it is.
      void pushQuietly(session, {
        kind: "decision",
        body: `${MESSAGES.leads.question}\n\n${renderQuestions(parsed?.questions)}`
      }, "question");
      return;
    }
    if (type === "approval/asked") {
      if (pushAllowed(session, "notifyApproval") === false) return;
      const key = event.data?.callId ?? fallbackKey(session, event);
      if (seen.has(key)) return;
      remember(key);
      const toolName = event.data?.toolName ?? MESSAGES.unknownTool;
      const reason = typeof event.data?.reason === "string" && event.data.reason.length > 0
        ? clip(event.data.reason, REASON_CHARS)
        : MESSAGES.noReason;
      // A missing authorisation is the other decision: the work cannot continue
      // without the user, so it is the same card kind as a question.
      void pushQuietly(session, {
        kind: "decision",
        body: `${MESSAGES.leads.approval}\n${MESSAGES.tool}: ${toolName}\n${MESSAGES.reason}: ${reason}`
      }, "approval");
      return;
    }
    if (type !== "turn/end") return;
    const reason = event.data?.reason?.kind;
    // Nothing has to run when a turn ends. `completed` means the model handed control
    // back and needs nothing from the user — the task the user asked to be told about
    // is done — and the watch expires at the turn boundary by construction
    // ({@link watchCoversTurn}), so there is no state left to clear. A failure is the
    // one thing still worth saying out loud, because a task that broke is exactly what
    // the user stepped away from.
    if (reason !== "error") return;
    const key = fallbackKey(session, event);
    if (pushAllowed(session, "notifyError") === false || seen.has(key)) return;
    remember(key);
    const detail = event.data.reason.error ?? {};
    const message = typeof detail.message === "string" && detail.message.length > 0
      ? detail.message
      : MESSAGES.unknownError;
    const code = typeof detail.code === "string" && detail.code.length > 0 ? ` (${detail.code})` : "";
    // A failure keeps a card of its own, and its own colour: it is not a decision the
    // user can answer, and it is the one card that must not be mistaken for one. The
    // four kinds cover everything the agent chooses to report; this is the harness
    // reporting that the agent stopped.
    void pushQuietly(session, {
      kind: "error",
      title: MESSAGES.titles.error,
      body: clip(`${message}${code}`, ERROR_CHARS)
    }, "error");
  });

  /** Build a redacted view of the stored configuration plus resolved defaults. */
  const configView = () => {
    const switches = liveConfig.flags();
    return {
      enabled: switches.enabled,
      prefix: liveConfig.text("prefix", ""),
      notifyQuestion: switches.notifyQuestion,
      notifyApproval: switches.notifyApproval,
      notifyError: switches.notifyError,
      maxChars: liveConfig.positiveInt("maxChars", CARD_MAX_CHARS),
      publicUrl: liveConfig.text("publicUrl", ""),
      webhookConfigured: liveConfig.text("webhookUrl", "").length > 0,
      secretConfigured: liveConfig.text("secret", "").length > 0
    };
  };

  /**
   * Turn a request body into a settings patch.
   *
   * An empty credential string means "leave the stored value alone", so a form
   * that renders credentials write-only cannot wipe them by accident. Clearing
   * a credential is explicit and travels as its own `unset` edit, so it never
   * depends on how the settings service treats an empty string.
   */
  const patchFrom = (body) => {
    const patch = {};
    if (typeof body.webhookUrl === "string" && body.webhookUrl.trim().length > 0) {
      const url = body.webhookUrl.trim();
      if (!url.startsWith("https://")) {
        const error = new Error(MESSAGES.webhookMustBeHttps);
        error.statusCode = 400;
        throw error;
      }
      patch.webhookUrl = url;
    }
    if (typeof body.secret === "string" && body.secret.length > 0) patch.secret = body.secret;
    if (typeof body.prefix === "string") patch.prefix = body.prefix;
    if (typeof body.publicUrl === "string") patch.publicUrl = body.publicUrl.trim();
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.notifyQuestion === "boolean") patch.notifyQuestion = body.notifyQuestion;
    if (typeof body.notifyApproval === "boolean") patch.notifyApproval = body.notifyApproval;
    if (typeof body.notifyError === "boolean") patch.notifyError = body.notifyError;
    if (Number.isSafeInteger(body.maxChars) && body.maxChars > 0) patch.maxChars = body.maxChars;
    return patch;
  };

  /** The credential fields the request body asks to clear, in entry order. */
  const clearsFrom = (body) => {
    const paths = [];
    if (body.clearWebhook === true) paths.push(["webhookUrl"]);
    if (body.clearSecret === true) paths.push(["secret"]);
    return paths;
  };

  /**
   * Apply a configuration patch through the settings service.
   *
   * `update` merges plain values; `mutate` is the declarative edit channel and
   * the only way to remove a stored credential, because "set this field to the
   * empty string" and "this field is unset" are different states. A build
   * without `mutate` clears by writing the empty string instead, which is the
   * closest equivalent it can express.
   *
   * @param patch - plain field values to merge; may be empty.
   * @param paths - credential field paths to unset.
   */
  const writeConfig = async (patch, paths) => {
    if (Object.keys(patch).length > 0) await ctx.settings.update(name, patch);
    if (paths.length === 0) return;
    if (typeof ctx.settings.mutate === "function") {
      await ctx.settings.mutate(name, paths.map((path) => ({ op: "unset", path })));
      return;
    }
    await ctx.settings.update(name, Object.fromEntries(paths.map(([key]) => [key, ""])));
  };

  /** One route serves both the read view and the write patch. */
  const configRoute = async (req, res) => {
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        sendJson(res, 200, configView());
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, message: MESSAGES.methodNotAllowed });
        return;
      }
      const body = await readJsonBody(req);
      await writeConfig(patchFrom(body), clearsFrom(body));
      sendJson(res, 200, { ok: true, message: MESSAGES.configSent, config: configView() });
    } catch (error) {
      sendJson(res, error?.statusCode ?? 500, { ok: false, message: String(error?.message ?? error) });
    }
  };

  /** One-shot delivery check from the settings page. */
  const testRoute = async (req, res) => {
    try {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, message: MESSAGES.methodNotAllowed });
        return;
      }
      const body = await readJsonBody(req);
      const message = typeof body.message === "string" && body.message.trim().length > 0
        ? body.message.trim()
        : MESSAGES.testBody;
      const storedUrl = liveConfig.text("webhookUrl", "");
      const target = typeof body.webhookUrl === "string" && body.webhookUrl.trim().length > 0
        ? body.webhookUrl.trim()
        : storedUrl;
      if (typeof target !== "string" || target.length === 0) {
        sendJson(res, 502, { ok: false, message: MESSAGES.notConfigured });
        return;
      }
      const storedSecret = liveConfig.text("secret", "");
      const secret = typeof body.secret === "string" && body.secret.length > 0 ? body.secret : storedSecret;
      // The delivery check assembles through the same functions a milestone does,
      // so the prefix, the format, and the length budget apply here too — which is
      // what makes it a rehearsal rather than a separate code path that can rot.
      // It carries no task and no workspace: it belongs to no session, and naming
      // one would make a delivery probe look like a real milestone.
      const options = {
        config: configRef,
        kindLabel: MESSAGES.testTitle,
        title: MESSAGES.testTitle,
        body: message,
        url: openUrl(),
        templateKey: "test"
      };
      const { payload, text, format } = buildPush(options);
      let outcome;
      try {
        outcome = await sendFeishu(target, {
          text,
          ...format === "card" ? { card: payload } : {}
        }, { secret: typeof secret === "string" ? secret : "" });
      } catch (error) {
        sendJson(res, 502, { ok: false, message: `${MESSAGES.testFailed}: ${String(error?.message ?? error)}` });
        return;
      }
      // A card the group would not take is worth saying out loud: the message did
      // arrive, but the page should not claim the change worked as intended.
      const fellBack = outcome.cardTried === true && outcome.cardAccepted === false;
      sendJson(res, 200, {
        ok: true,
        format,
        cardAccepted: outcome.cardAccepted === true,
        message: fellBack ? `${MESSAGES.testSentText} ${MESSAGES.cardRefused}` : MESSAGES.testSent,
        ...fellBack ? { detail: String(outcome.cardError ?? "") } : {}
      });
    } catch (error) {
      sendJson(res, error?.statusCode ?? 502, { ok: false, message: String(error?.message ?? error) });
    }
  };

  /**
   * A stub context answers `register()` with a disposer; the live webserver also
   * offers `unregister`. Both are honoured so teardown is correct either way.
   */
  const mount = (path, handler) => {
    const server = ctx.webServer;
    const previous = typeof server.unregister === "function" ? server.unregister(path) : undefined;
    const disposer = server.register({ kind: "exact", path, handler });
    return () => {
      if (typeof disposer === "function") disposer();
      if (typeof previous === "function") previous();
    };
  };

  ctx.effect(() => mount(`${ROUTE_BASE}/config`, configRoute), `${name}: config route`);
  ctx.effect(() => mount(`${ROUTE_BASE}/test`, testRoute), `${name}: test route`);
}

export { Config, apply, inject, name };

/**
 * Test seam. `test/smoke.mjs` recomputes the signature independently to prove
 * the request URL really carries a Feishu signature, and `test/live-check.mjs`
 * sends one real message through the same transport the runtime uses.
 */
export const __testing = { sendFeishu, postFeishu, feishuSign, buildMessage, buildCard, buildPush, escapeMarkdown, renderQuestions, stamp, clip };
export { sendFeishu };
