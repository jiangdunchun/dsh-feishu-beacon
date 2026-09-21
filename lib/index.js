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

/** Services required by the host half. */
const inject = ["tools", "workspaceRegistry", "settings", "webServer"];

/** Settings namespace and route prefix, both derived from one string. */
const NAMESPACE = "dsh-feishu-beacon";
const ROUTE_BASE = "/api/dsh-feishu-beacon";

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
 * Both credentials carry `role("secret")`, so the settings service strips them
 * from every wire-facing view and a reader only ever learns whether a value is
 * stored.
 */
const Config = z.object({
  webhookUrl: z.string().role("secret").default(""),
  secret: z.string().role("secret").default(""),
  enabled: z.boolean().default(true),
  prefix: z.string().default(""),
  notifyQuestion: z.boolean().default(true),
  notifyApproval: z.boolean().default(true),
  notifyError: z.boolean().default(true),
  maxChars: z.number().default(1800),
  publicUrl: z.string().default("")
});

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
 * POST one text message to a Feishu custom-bot webhook.
 *
 * The success code is read leniently: a generic endpoint may answer without one,
 * and a missing code is not a failure. A present numeric non-zero code is.
 *
 * @param webhookUrl - the bot webhook URL.
 * @param text - the message body.
 * @param options - optional signing secret and abort signal.
 * @returns the parsed response body.
 * @throws when the endpoint rejects the message or the transport fails.
 */
async function sendFeishu(webhookUrl, text, options = {}) {
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
    body: JSON.stringify({ msg_type: "text", content: { text } }),
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

/**
 * Assemble the pushed message.
 *
 * @param options - configuration snapshot and content.
 * @returns the text to POST.
 */
function buildMessage(options) {
  const { config, kindLabel, title, task, workspace, body, url } = options;
  const prefix = typeof config.prefix === "string" && config.prefix.length > 0 ? `${config.prefix} ` : "";
  const head = title === undefined ? `${prefix}${NAMESPACE} - ${kindLabel}` : `${prefix}${title}`;
  const lines = [head];
  if (task.length > 0) lines.push(`${MESSAGES.task}: ${task}`);
  if (workspace.length > 0) lines.push(`${MESSAGES.workspace}: ${workspace}`);
  lines.push(`${MESSAGES.time}: ${stamp()}`);
  if (typeof url === "string" && url.length > 0) lines.push(`${MESSAGES.openAt}: ${url}`);
  lines.push("", body);
  const text = lines.join("\n");
  const maxChars = Number.isSafeInteger(config.maxChars) && config.maxChars > 0 ? config.maxChars : 1800;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
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
  const scope = ctx.settings.register(NAMESPACE, Config, { base: config });

  /** Configuration is re-read before every push, so edits apply without a restart. */
  const settings = () => scope.get();

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
    const configured = settings().publicUrl;
    if (typeof configured === "string" && configured.length > 0) return configured;
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
    const current = settings();
    const webhookUrl = typeof current.webhookUrl === "string" ? current.webhookUrl : "";
    if (webhookUrl.length === 0) throw new Error(MESSAGES.notConfigured);
    const cwd = session?.header?.cwd;
    const title = content.title ?? MESSAGES.titles[content.kind] ?? MESSAGES.titles.error;
    const text = buildMessage({
      config: current,
      kindLabel: MESSAGES.kindLabels[content.kind] ?? MESSAGES.kindLabels.progress,
      title: content.title,
      task: taskName(session),
      workspace: await workspaceTitle(cwd) || dirName(cwd),
      body: content.body,
      url: content.url === false ? "" : openUrl()
    });
    await sendFeishu(webhookUrl, text, {
      secret: typeof current.secret === "string" ? current.secret : "",
      ...content.signal === undefined ? {} : { signal: content.signal }
    });
    return text;
  };

  /**
   * Push from an event hook. Event delivery must never throw into the session
   * event bus, so every failure is contained and logged.
   */
  const pushQuietly = async (session, content, label) => {
    try {
      await push(session, content);
    } catch (error) {
      ctx.logger?.warn?.(`${NAMESPACE}: ${label} push failed: ${String(error?.message ?? error)}`);
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
      const current = settings();
      if (current.enabled === false) throw new Error(MESSAGES.disabled);
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
      if (settings().enabled === false || settings().notifyQuestion === false) return;
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
      if (settings().enabled === false || settings().notifyApproval === false) return;
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
      if (settings().enabled === false || settings().notifyError === false) return;
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
    const current = settings();
    return {
      enabled: current.enabled !== false,
      prefix: typeof current.prefix === "string" ? current.prefix : "",
      notifyQuestion: current.notifyQuestion !== false,
      notifyApproval: current.notifyApproval !== false,
      notifyError: current.notifyError !== false,
      maxChars: Number.isSafeInteger(current.maxChars) ? current.maxChars : 1800,
      publicUrl: typeof current.publicUrl === "string" ? current.publicUrl : "",
      webhookConfigured: typeof current.webhookUrl === "string" && current.webhookUrl.length > 0,
      secretConfigured: typeof current.secret === "string" && current.secret.length > 0
    };
  };

  /**
   * Turn a request body into a settings patch.
   *
   * An empty credential string means "leave the stored value alone", so a form
   * that renders credentials write-only cannot wipe them by accident. Clearing
   * a credential is explicit: `clearWebhook` / `clearSecret`.
   */
  const patchFrom = (body) => {
    const patch = {};
    if (body.clearWebhook === true) patch.webhookUrl = "";
    if (body.clearSecret === true) patch.secret = "";
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
      const patch = patchFrom(await readJsonBody(req));
      if (Object.keys(patch).length > 0) await scope.update(patch);
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
      const current = settings();
      const target = typeof body.webhookUrl === "string" && body.webhookUrl.trim().length > 0
        ? body.webhookUrl.trim()
        : current.webhookUrl;
      if (typeof target !== "string" || target.length === 0) {
        sendJson(res, 502, { ok: false, message: MESSAGES.notConfigured });
        return;
      }
      const secret = typeof body.secret === "string" && body.secret.length > 0 ? body.secret : current.secret;
      const text = [
        `${NAMESPACE} - ${MESSAGES.testTitle}`,
        `${MESSAGES.time}: ${stamp()}`,
        ...openUrl().length > 0 ? [`${MESSAGES.openAt}: ${openUrl()}`] : [],
        "",
        message
      ].join("\n");
      try {
        await sendFeishu(target, text, { secret: typeof secret === "string" ? secret : "" });
      } catch (error) {
        sendJson(res, 502, { ok: false, message: `${MESSAGES.testFailed}: ${String(error?.message ?? error)}` });
        return;
      }
      sendJson(res, 200, { ok: true, message: MESSAGES.testSent });
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

  ctx.effect(() => mount(`${ROUTE_BASE}/config`, configRoute), `${NAMESPACE}: config route`);
  ctx.effect(() => mount(`${ROUTE_BASE}/test`, testRoute), `${NAMESPACE}: test route`);
}

export { Config, apply, inject, name };

/**
 * Test seam. `test/smoke.mjs` recomputes the signature independently to prove
 * the request URL really carries a Feishu signature, and `test/live-check.mjs`
 * sends one real message through the same transport the runtime uses.
 */
export const __testing = { sendFeishu, feishuSign, buildMessage, renderQuestions, stamp, clip };
export { sendFeishu };
