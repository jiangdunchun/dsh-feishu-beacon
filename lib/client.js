/**
 * dsh-feishu-beacon — Client half.
 *
 * This is not an ordinary ES module: it is a self-registering browser bundle
 * that hands a factory to the harness module loader under the package name.
 * The factory depends on `react` and nothing else, which is deliberate — every
 * extra dependency is another way for the settings page to fail to load.
 *
 * The page is styled against the same design tokens and the same control
 * geometry as the shipped settings pages (`ui-primitives/Switch.module.css`,
 * `settings-form/fields.module.css`) rather than against hand-picked colors, so
 * it follows the theme and cannot drift from its neighbours.
 *
 * Every control applies itself. There is no Save button on purpose: a save step
 * would mean the page could show a value the host does not hold, and a
 * webhook URL is exactly the kind of setting a user tries and then walks away
 * from. The only button is the delivery check, because sending a message is not
 * a configuration change.
 *
 * The browser never receives a credential. It reads a redacted view from the
 * host route and writes write-only patches back, so this file has no storage of
 * its own.
 */

window.__ModuleLoader__.load({
  id: "dsh-feishu-beacon",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** Routes served by this plugin's host half. */
    const CONFIG_PATH = "/api/dsh-feishu-beacon/config";
    const TEST_PATH = "/api/dsh-feishu-beacon/test";

    /**
     * How long a text edit waits before it is written.
     *
     * Typing a webhook URL is a burst of keystrokes; one write per settled burst
     * keeps the settings document off the wire per character while still landing
     * the value without a save.
     */
    const WRITE_DELAY_MS = 400;

    /** Every user-visible string of the settings section. */
    const MESSAGES = {
      title: "Feishu beacon",
      intro:
        "Pushes agent milestones and human-attention events to a Feishu custom-bot webhook. "
        + "The webhook URL and signing secret are stored on the host and are never sent back to this page. "
        + "Changes apply as you make them.",
      connection: "Connection",
      webhook: "Webhook URL",
      webhookPlaceholder: "https://open.feishu.cn/open-apis/bot/v2/hook/...",
      webhookStored: "stored",
      webhookMissing: "not set",
      webhookHint: "Must be an https:// URL. Leave empty to keep the stored one, or clear it with Clear.",
      secret: "Signing secret",
      secretPlaceholder: "leave empty to keep the stored secret",
      secretHint: "Only needed when the bot enables signature verification.",
      notifications: "Notifications",
      enabled: "Enabled",
      enabledHint: "Master switch. While off, nothing is pushed and the tool reports that it is disabled.",
      notifyQuestion: "Notify on questions",
      notifyQuestionHint: "Pushes every ask_user_question with its full option list.",
      notifyApproval: "Notify on approvals",
      notifyApprovalHint: "Pushes every approval request.",
      notifyError: "Notify on failed turns",
      notifyErrorHint: "Pushes only failed turns. Successful turns stay silent.",
      messages: "Messages",
      prefix: "Title prefix",
      prefixHint: "Prepended to every pushed title. Empty means no prefix.",
      publicUrl: "Host URL in messages",
      publicUrlHint: "Optional. Adds an Open at line so the message points back at this harness.",
      maxChars: "Max characters",
      maxCharsHint: "A longer message is truncated with an ellipsis.",
      format: "Message format",
      formatPlaceholder: "card",
      formatHint: "card sends an interactive card and falls back to text if the group refuses one; text never tries a card.",
      sendTest: "Send test",
      sending: "Sending...",
      clear: "Clear",
      applied: "Applied",
      testOk: "Test message sent",
      failedToLoad: "Failed to load the configuration",
      failedToApply: "Could not apply the change",
      httpError: (status) => `Request failed with status ${String(status)}`
    };

    /** Read a JSON response, surfacing the host's own message on failure. */
    async function requestJson(path, options) {
      const response = await fetch(path, options);
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        const message = typeof payload?.message === "string" && payload.message.length > 0
          ? payload.message
          : MESSAGES.httpError(response.status);
        throw new Error(message);
      }
      return payload;
    }

    /**
     * The section's transport object. It carries no state: the host owns the
     * configuration, and every call re-reads or re-writes it.
     */
    const controller = {
      load: () => requestJson(CONFIG_PATH, { method: "GET" }),
      update: (patch) => requestJson(CONFIG_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      }),
      test: (payload) => requestJson(TEST_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {})
      })
    };

    /**
     * The section's stylesheet.
     *
     * Values are copied from the shipped settings controls — the switch
     * capsule, the field stack, the input, the hint, and the primary action —
     * so this page is indistinguishable from a built-in one under any theme.
     * Class names are prefixed with a content hash so two builds, or two
     * versions during a hot reload, cannot collide.
     */
    const STYLE_ID = "dsh-feishu-beacon/settings-section.css";

    /** Scope prefix for this section's class names. */
    const S = "fbn7k";

    const CSS = `
.${S}-section{display:flex;flex-direction:column;gap:12px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}
.${S}-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}
.${S}-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6}
.${S}-form{display:flex;flex-direction:column}
.${S}-group{margin:14px 0 0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}
.${S}-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.${S}-field + .${S}-field{border-top:0.5px solid var(--dsw-alias-border-l2)}
.${S}-group + .${S}-field{padding-top:4px}
.${S}-head{display:flex;align-items:center;gap:8px}
.${S}-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.${S}-state{flex:none;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${S}-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.${S}-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.${S}-reset:disabled{cursor:default;opacity:0.5}
.${S}-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.${S}-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.${S}-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.${S}-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.${S}-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${S}-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.${S}-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}
.${S}-switch:disabled{cursor:default;opacity:0.5}
.${S}-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.${S}-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.${S}-switch[aria-checked='false'] .${S}-thumb{background:var(--dsw-alias-switch-thumb)}
.${S}-switch[aria-checked='true'] .${S}-thumb{transform:translateX(16px)}
.${S}-footer{display:flex;align-items:center;gap:8px;padding-top:16px}
.${S}-status{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${S}-status[data-tone='error']{color:var(--dsw-alias-label-error)}
.${S}-primary{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.${S}-primary:disabled{opacity:0.4;cursor:default}
.${S}-primary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
`;

    /**
     * Install the stylesheet once per document.
     *
     * The loader claims the `<style>` tags a factory injects and removes them
     * with the plugin, so reloading replaces the sheet instead of stacking
     * copies.
     */
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-feishu-beacon";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** One on/off control, geometry and state semantics identical to the shipped switch. */
    function Toggle(props) {
      return h("div", { className: `${S}-field` },
        h("div", { className: `${S}-head` },
          h("span", { className: `${S}-label`, id: props.id }, props.label),
          h("button", {
            type: "button",
            role: "switch",
            "aria-checked": props.checked === true,
            "aria-labelledby": props.id,
            disabled: props.disabled === true,
            className: `${S}-switch`,
            onClick: () => props.onChange(props.checked !== true)
          }, h("span", { className: `${S}-thumb` }))),
        props.hint === undefined ? null : h("p", { className: `${S}-hint` }, props.hint));
    }

    /**
     * One labelled control.
     *
     * `state` is the write-only readout a credential needs — the browser never
     * receives the value, so all it can show is whether one is stored — and
     * `onReset` is the clear for a field that inherits a stored value.
     *
     * `parse` maps the raw input to the value to report, or `undefined` for a
     * draft the host would reject; dropping it keeps the control responsive
     * without writing something that cannot be stored.
     */
    function Field(props) {
      return h("div", { className: `${S}-field` },
        h("div", { className: `${S}-head` },
          h("label", { className: `${S}-label`, htmlFor: props.id }, props.label),
          props.state === undefined ? null : h("span", { className: `${S}-state` }, props.state),
          props.onReset === undefined ? null : h("button", {
            type: "button",
            className: `${S}-reset`,
            disabled: props.disabled === true,
            onClick: props.onReset
          }, MESSAGES.clear)),
        h("input", {
          id: props.id,
          className: `${S}-input`,
          type: props.type ?? "text",
          value: props.value,
          placeholder: props.placeholder,
          ...props.autoComplete === undefined ? {} : { autoComplete: props.autoComplete },
          disabled: props.disabled === true,
          onChange: (event) => {
            const parsed = props.parse === undefined ? event.target.value : props.parse(event.target.value);
            if (parsed !== undefined) props.onChange(parsed);
          }
        }),
        props.hint === undefined ? null : h("p", { className: `${S}-hint` }, props.hint));
    }

    /** The credential readout: this page can learn whether one is stored, never what it is. */
    function credentialState(configured) {
      return configured === true ? MESSAGES.webhookStored : MESSAGES.webhookMissing;
    }

    /**
     * The settings form for one resolved configuration view.
     *
     * This half is pure: it reads `view`/`draft` and reports edits through
     * callbacks, so the container below it owns the only state there is. That
     * split is what `test/client-smoke.mjs` exercises without a browser.
     *
     * @param props - the configuration view, the drafts, the status, and the actions.
     * @returns the form element tree.
     */
    function Form(props) {
      const view = props.view;
      const busy = props.busy === true;
      const draft = props.draft ?? {};
      const draftOf = (key, fallback) => (Object.hasOwn(draft, key) ? draft[key] : fallback);
      const status = props.status ?? { tone: "note", text: "" };
      return h("div", { className: `${S}-section` },
        h("h2", { className: `${S}-heading` }, MESSAGES.title),
        h("p", { className: `${S}-intro` }, MESSAGES.intro),
        h("div", { className: `${S}-form` },
          h("h3", { className: `${S}-group` }, MESSAGES.connection),
          h(Field, {
            id: "dsh-feishu-beacon-webhook",
            label: MESSAGES.webhook,
            value: draftOf("webhookUrl", ""),
            placeholder: MESSAGES.webhookPlaceholder,
            hint: MESSAGES.webhookHint,
            state: credentialState(view.webhookConfigured),
            onReset: view.webhookConfigured === true ? props.onClearWebhook : undefined,
            disabled: busy,
            onChange: (value) => props.onText("webhookUrl", value)
          }),
          h(Field, {
            id: "dsh-feishu-beacon-secret",
            label: MESSAGES.secret,
            type: "password",
            autoComplete: "off",
            value: draftOf("secret", ""),
            placeholder: MESSAGES.secretPlaceholder,
            hint: MESSAGES.secretHint,
            state: credentialState(view.secretConfigured),
            onReset: view.secretConfigured === true ? props.onClearSecret : undefined,
            disabled: busy,
            onChange: (value) => props.onText("secret", value)
          }),
          h("h3", { className: `${S}-group` }, MESSAGES.messages),
          h(Field, {
            id: "dsh-feishu-beacon-prefix",
            label: MESSAGES.prefix,
            value: draftOf("prefix", view.prefix ?? ""),
            hint: MESSAGES.prefixHint,
            disabled: busy,
            onChange: (value) => props.onText("prefix", value)
          }),
          h(Field, {
            id: "dsh-feishu-beacon-public-url",
            label: MESSAGES.publicUrl,
            value: draftOf("publicUrl", view.publicUrl ?? ""),
            hint: MESSAGES.publicUrlHint,
            disabled: busy,
            onChange: (value) => props.onText("publicUrl", value)
          }),
          h(Field, {
            id: "dsh-feishu-beacon-max-chars",
            label: MESSAGES.maxChars,
            value: draftOf("maxChars", String(view.maxChars ?? 3000)),
            hint: MESSAGES.maxCharsHint,
            disabled: busy,
            onChange: (value) => props.onText("maxChars", value)
          }),
          h(Field, {
            id: "dsh-feishu-beacon-format",
            label: MESSAGES.format,
            value: draftOf("format", view.format ?? "card"),
            hint: MESSAGES.formatHint,
            placeholder: MESSAGES.formatPlaceholder,
            disabled: busy,
            // Only the two values the route accepts are written; anything else
            // would be dropped by the host and then reverted without saying why.
            parse: (value) => {
              const normalized = value.trim().toLowerCase();
              return normalized === "card" || normalized === "text" ? normalized : undefined;
            },
            onChange: (value) => props.onText("format", value)
          }),
          h("h3", { className: `${S}-group` }, MESSAGES.notifications),
          h(Toggle, {
            id: "dsh-feishu-beacon-enabled",
            label: MESSAGES.enabled,
            hint: MESSAGES.enabledHint,
            checked: view.enabled === true,
            disabled: busy,
            onChange: (value) => props.onToggle("enabled", value)
          }),
          h(Toggle, {
            id: "dsh-feishu-beacon-notify-question",
            label: MESSAGES.notifyQuestion,
            hint: MESSAGES.notifyQuestionHint,
            checked: view.notifyQuestion === true,
            disabled: busy,
            onChange: (value) => props.onToggle("notifyQuestion", value)
          }),
          h(Toggle, {
            id: "dsh-feishu-beacon-notify-approval",
            label: MESSAGES.notifyApproval,
            hint: MESSAGES.notifyApprovalHint,
            checked: view.notifyApproval === true,
            disabled: busy,
            onChange: (value) => props.onToggle("notifyApproval", value)
          }),
          h(Toggle, {
            id: "dsh-feishu-beacon-notify-error",
            label: MESSAGES.notifyError,
            hint: MESSAGES.notifyErrorHint,
            checked: view.notifyError === true,
            disabled: busy,
            onChange: (value) => props.onToggle("notifyError", value)
          })),
        h("div", { className: `${S}-footer` },
          h("p", {
            className: `${S}-status`,
            role: status.tone === "error" ? "alert" : undefined,
            "data-tone": status.tone
          }, status.text),
          h("button", {
            type: "button",
            className: `${S}-primary`,
            disabled: busy,
            onClick: props.onTest
          }, busy ? MESSAGES.sending : MESSAGES.sendTest)));
    }

    /**
     * The settings section container: loads the view, applies every edit, and
     * owns the one action that is not a configuration change.
     *
     * @param props - the injected controller.
     * @returns the section element tree.
     */
    function FeishuBeaconSection(props) {
      const ctrl = props.controller;
      const [view, setView] = React.useState(null);
      const [draft, setDraft] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState({ tone: "note", text: "" });

      /** Latest staged patch, the drafts a user has typed, and the debounce timer. */
      const state = React.useRef({ patch: {}, drafts: {}, timer: null, mounted: true });

      /**
       * Write every staged edit, then drop the drafts the host accepted.
       *
       * A write is the whole point of the page, so nothing is assumed: the
       * response says what the host now holds, and a draft is kept only where
       * that differs from what was typed — an empty credential kept in place, a
       * field the route rejected. Keeping it is what leaves the refused text on
       * screen for the user to correct instead of silently reverting it.
       *
       * @returns whether the write landed.
       */
      const flush = async () => {
        const patch = state.current.patch;
        if (Object.keys(patch).length === 0) return true;
        state.current.patch = {};
        try {
          const result = await ctrl.update(patch);
          if (state.current.mounted) {
            if (result?.config !== undefined) setView(result.config);
            const accepted = result?.config ?? {};
            const kept = {};
            for (const [key, value] of Object.entries(state.current.drafts)) {
              // A credential never comes back to compare against; keep it while
              // it holds something the user typed, since the page is the only
              // place that value exists.
              if (key === "webhookUrl" || key === "secret") {
                if (value !== "") kept[key] = value;
              } else if (accepted[key] !== value) kept[key] = value;
            }
            state.current.drafts = kept;
            setDraft({ ...kept });
            setStatus({ tone: "note", text: MESSAGES.applied });
          }
          return true;
        } catch (cause) {
          state.current.patch = { ...patch, ...state.current.patch };
          if (state.current.mounted) {
            setStatus({ tone: "error", text: `${MESSAGES.failedToApply}: ${String(cause?.message ?? cause)}` });
          }
          return false;
        }
      };

      /** Stop the pending debounce, keeping the staged patch. */
      const cancelTimer = () => {
        if (state.current.timer !== null) {
          clearTimeout(state.current.timer);
          state.current.timer = null;
        }
      };

      /** Stage one edit and schedule its write. */
      const stage = (patch) => {
        Object.assign(state.current.patch, patch);
        Object.assign(state.current.drafts, patch);
        setDraft({ ...state.current.drafts });
        cancelTimer();
        state.current.timer = setTimeout(() => {
          state.current.timer = null;
          void flush();
        }, WRITE_DELAY_MS);
      };

      /**
       * Apply a toggle at once: a switch has no half-typed state to wait for.
       *
       * The switch moves immediately so it feels like a switch, and moves back
       * if the write is refused — a control that showed a state the host did not
       * accept would be a lie the user could act on.
       */
      const applyToggle = (key, value) => {
        const previous = view === null ? undefined : view[key];
        setView((current) => (current === null ? current : { ...current, [key]: value }));
        stage({ [key]: value });
        cancelTimer();
        void flush().then((landed) => {
          if (landed || previous === undefined || !state.current.mounted) return;
          setView((current) => (current === null ? current : { ...current, [key]: previous }));
        });
      };

      /**
       * Clear a stored credential.
       *
       * "Empty" and "unset" are different stored states, so a clear does not
       * type an empty value into the field: it drops the local draft — and any
       * value staged for that field, so a typed-then-cleared credential is one
       * unset rather than a write followed by an unset — and asks the route for
       * the explicit unset.
       */
      const clearCredential = (key) => {
        delete state.current.drafts[key];
        delete state.current.patch[key];
        setDraft({ ...state.current.drafts });
        stage({ [key === "webhookUrl" ? "clearWebhook" : "clearSecret"]: true });
        cancelTimer();
        void flush();
      };

      const load = () => {
        setStatus({ tone: "note", text: "" });
        return ctrl.load().then(
          (next) => {
            if (state.current.mounted) setView(next);
          },
          (cause) => {
            if (state.current.mounted) {
              setStatus({ tone: "error", text: `${MESSAGES.failedToLoad}: ${String(cause?.message ?? cause)}` });
            }
          }
        );
      };

      React.useEffect(() => {
        state.current.mounted = true;
        load();
        return () => {
          state.current.mounted = false;
          cancelTimer();
        };
      }, []);

      if (view === null) {
        return h("div", { className: `${S}-section` },
          h("h2", { className: `${S}-heading` }, MESSAGES.title),
          h("p", { className: `${S}-intro` }, MESSAGES.intro),
          h("p", { className: `${S}-status`, "data-tone": status.tone },
            status.text.length > 0 ? status.text : MESSAGES.failedToLoad));
      }

      return h(Form, {
        view,
        draft,
        busy,
        status,
        // The route takes a number for the budget and strings for everything
        // else, so the one numeric field is converted here, next to the reason.
        onText: (key, value) => stage({ [key]: key === "maxChars" ? Number.parseInt(value, 10) : value }),
        onToggle: applyToggle,
        onClearWebhook: () => clearCredential("webhookUrl"),
        onClearSecret: () => clearCredential("secret"),
        onTest: () => {
          setBusy(true);
          setStatus({ tone: "note", text: "" });
          void (async () => {
            // The test must exercise what the page shows, so a burst that has
            // not been written yet is written first. The drafts are read before
            // the flush clears them.
            const draftWebhook = state.current.drafts.webhookUrl;
            const draftSecret = state.current.drafts.secret;
            // Only the fields the page actually holds are sent; an absent one
            // means "use the stored value", which is exactly the state of a
            // field the user never touched.
            const body = typeof draftWebhook === "string" && draftWebhook.trim().length > 0
              ? {
                webhookUrl: draftWebhook.trim(),
                ...typeof draftSecret === "string" && draftSecret.length > 0 ? { secret: draftSecret } : {}
              }
              : {};
            cancelTimer();
            await flush();
            return ctrl.test(body);
          })().then(
            (result) => {
              setBusy(false);
              setStatus({ tone: "note", text: result?.message ?? MESSAGES.testOk });
            },
            (cause) => {
              setBusy(false);
              setStatus({ tone: "error", text: String(cause?.message ?? cause) });
            }
          );
        }
      });
    }

    const inject = ["slots"];

    /**
     * Register the settings section.
     *
     * @param ctx - client context carrying the slot registry.
     */
    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-feishu-beacon",
        order: 26,
        label: () => MESSAGES.title,
        inject: () => ({ controller })
      }, FeishuBeaconSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.controller = controller;
    exports.Section = FeishuBeaconSection;
    exports.Form = Form;
    return module.exports;
  }
});
