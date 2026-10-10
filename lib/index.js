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
const inject = ["tools", "workspaceRegistry", "settings", "webServer"];

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
 * Every user-visible and model-visible string in one block, so wiring a
 * translation or making a label configurable touches exactly one place.
 */
const MESSAGES = {
  toolDescription:
    "Push a progress message to the user's phone (Feishu) through dsh-feishu-beacon. "
    + "Enable it when the user asks for progress reports - for example \"report your progress "
    + "through dsh-feishu-beacon\" - and then call it at these milestones: "
    + "(1) the task is broken down - state the whole task and how many steps it has, in one go; "
    + "(2) a key part is finished - say what was completed and what it produced or concluded; "
    + "(3) a decision is needed - give the background, what must be decided, the available options, "
    + "and your recommendation. "
    + "Do not call it every turn; call it only at real milestones. Never push empty chatter such as "
    + "\"working on it\". The message must stand alone - the user may see only this one message.",
  paramMessage: "The progress text to push. It must stand alone: the user may see only this message.",
  paramKind:
    "Milestone kind used for the pushed title: plan, progress, decision, or done. Defaults to progress.",
  outputPushed: (kind) => `Pushed (${kind})`,
  noAgentSession: "dsh_beacon requires an agent Session",
  disabled: "dsh-feishu-beacon is disabled (enabled: false); the message was not pushed",
  notConfigured:
    "dsh-feishu-beacon has no webhookUrl configured; set it in Settings > Feishu beacon, then retry",
  kindLabels: {
    plan: "PLAN",
    progress: "PROGRESS",
    decision: "DECISION",
    done: "DONE"
  },
  titles: {
    question: "Answer needed",
    approval: "Authorization needed",
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
    "this group did not accept an interactive card, so messages will arrive as plain text. "
    + "Set the format to text to stop trying.",
  testFailed: "Test message failed",
  webhookRequired: "webhookUrl is required",
  webhookMustBeHttps: "webhookUrl must be an https:// URL",
  secretMustBeString: "secret must be a string",
  notFound: "Not found",
  methodNotAllowed: "Method not allowed",
  badRequest: "Malformed request body",
  bodyTooLarge: "Request body is too large",
  deliveryFailed: "Feishu rejected the message",
  emptyMessage: "dsh_beacon requires a non-empty message"
};

/**
 * Resolved plugin configuration.
 *
 * Every field is `.volatile()`: the settings service only offers a form for an
 * entry that has at least one volatile field, and a volatile field is the one
 * the settings page is allowed to edit. `apply` is re-run with a freshly
 * resolved config after each edit, so reading the values through
 * {@link fieldValue} is always reading the live configuration.
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
  format: z.string().volatile().default("card"),
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

/** Join the text blocks of one `assistant/message` payload. */
function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
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
  const format = fieldValue(config, "format", "card") === "text" ? "text" : "card";
  const fallback = format === "card" ? CARD_MAX_CHARS : 1800;
  const budget = fieldValue(config, "maxChars", fallback);
  const maxChars = Number.isSafeInteger(budget) && budget > 0 ? budget : fallback;
  return { head, meta, body: content, maxChars, format };
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
 * @returns the text to POST.
 */
function buildMessage(options) {
  const parts = messageParts(options);
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
 * @returns the card payload to POST.
 */
function buildCard(options) {
  const parts = messageParts(options);
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
 * Assemble one push in the configured format.
 *
 * @param options - configuration snapshot and content.
 * @returns the payload to POST, and the format it is in.
 */
function buildPush(options) {
  const parts = messageParts(options);
  if (parts.format === "text") return { payload: { msg_type: "text", content: { text: buildMessage(options) } }, format: "text" };
  return { payload: buildCard(options), format: "card" };
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
    const { payload, format } = buildPush(options);
    const textPayload = format === "text" ? payload : { msg_type: "text", content: { text: buildMessage(options) } };
    const secret = liveConfig.text("secret", "");
    const outcome = await sendFeishu(webhookUrl, {
      text: textPayload,
      ...format === "card" ? { card: payload } : {}
    }, {
      secret,
      ...content.signal === undefined ? {} : { signal: content.signal }
    });
    if (outcome.cardTried && outcome.cardAccepted === false) {
      ctx.logger?.warn?.(`${name}: the card was refused, the message was sent as text instead: ${String(outcome.cardError ?? "")}`);
    }
    return textPayload.content.text;
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

  ctx.tools.register(defineTool({
    name: "dsh_beacon",
    description: MESSAGES.toolDescription,
    parameters: {
      message: { type: "string", required: true, description: MESSAGES.paramMessage },
      kind: { type: "string", description: MESSAGES.paramKind }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", required: true },
          delivered: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: MESSAGES.outputPushed(value.kind) }]
    },
    async execute(args, exec) {
      const session = exec.agent?.session;
      if (session === undefined) throw new Error(MESSAGES.noAgentSession);
      if (liveConfig.flags().enabled === false) throw new Error(MESSAGES.disabled);
      const body = typeof args.message === "string" ? args.message.trim() : "";
      if (body.length === 0) throw new Error(MESSAGES.emptyMessage);
      const kind = typeof args.kind === "string" && Object.hasOwn(MESSAGES.kindLabels, args.kind)
        ? args.kind
        : "progress";
      await push(session, { kind, body, signal: exec.signal });
      return { kind, delivered: true };
    }
  }));

  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type === "tool/call") {
      if (event.data?.name !== "ask_user_question") return;
      const switches = liveConfig.flags();
      if (switches.enabled === false || switches.notifyQuestion === false) return;
      const key = event.data.callId ?? fallbackKey(session, event);
      if (seen.has(key)) return;
      remember(key);
      let parsed;
      try {
        parsed = JSON.parse(event.data.arguments ?? "{}");
      } catch {
        parsed = {};
      }
      void pushQuietly(session, {
        title: MESSAGES.titles.question,
        body: renderQuestions(parsed?.questions)
      }, "question");
      return;
    }
    if (type === "approval/asked") {
      const switches = liveConfig.flags();
      if (switches.enabled === false || switches.notifyApproval === false) return;
      const key = event.data?.callId ?? fallbackKey(session, event);
      if (seen.has(key)) return;
      remember(key);
      const toolName = event.data?.toolName ?? MESSAGES.unknownTool;
      const reason = typeof event.data?.reason === "string" && event.data.reason.length > 0
        ? clip(event.data.reason, REASON_CHARS)
        : MESSAGES.noReason;
      void pushQuietly(session, {
        title: MESSAGES.titles.approval,
        body: `${MESSAGES.tool}: ${toolName}\n${MESSAGES.reason}: ${reason}`
      }, "approval");
      return;
    }
    if (type === "turn/end") {
      if (event.data?.reason?.kind !== "error") return;
      const switches = liveConfig.flags();
      if (switches.enabled === false || switches.notifyError === false) return;
      const key = fallbackKey(session, event);
      if (seen.has(key)) return;
      remember(key);
      const failure = event.data.reason.error ?? {};
      const detail = typeof failure.message === "string" && failure.message.length > 0
        ? failure.message
        : MESSAGES.unknownError;
      const code = typeof failure.code === "string" && failure.code.length > 0 ? ` (${failure.code})` : "";
      void pushQuietly(session, {
        title: MESSAGES.titles.error,
        body: clip(`${detail}${code}`, ERROR_CHARS)
      }, "error");
    }
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
      format: liveConfig.text("format", "card") === "text" ? "text" : "card",
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
    if (body.format === "card" || body.format === "text") patch.format = body.format;
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
      const { payload, format } = buildPush(options);
      const textPayload = format === "text" ? payload : { msg_type: "text", content: { text: buildMessage(options) } };
      let outcome;
      try {
        outcome = await sendFeishu(target, {
          text: textPayload,
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
