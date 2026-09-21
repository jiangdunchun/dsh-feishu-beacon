/**
 * dsh-feishu-beacon — Client half.
 *
 * This is not an ordinary ES module: it is a self-registering browser bundle
 * that hands a factory to the harness module loader under the package name.
 * The factory depends on `react` and nothing else, which is deliberate — every
 * extra dependency is another way for the settings page to fail to load.
 *
 * The browser never receives a credential. It reads a redacted view from the
 * host route and writes write-only patches back, which is why this file has no
 * storage of its own: `ctx.settings` plus `settings.yaml` on the host owns the
 * configuration.
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

    /** Every user-visible string of the settings section. */
    const MESSAGES = {
      title: "Feishu beacon",
      intro:
        "Pushes agent milestones and human-attention events to a Feishu custom-bot webhook. "
        + "The webhook URL and signing secret are stored on the host and are never sent back to this page.",
      webhook: "Webhook URL",
      webhookPlaceholder: "https://open.feishu.cn/open-apis/bot/v2/hook/...",
      webhookStored: "stored",
      webhookMissing: "not set",
      webhookHint: "Leave empty to keep the stored URL. Use Clear to remove it.",
      secret: "Signing secret",
      secretPlaceholder: "leave empty to keep the stored secret",
      secretHint: "Only needed when the bot enables signature verification.",
      prefix: "Title prefix",
      prefixHint: "Prepended to every pushed title. Empty means no prefix.",
      publicUrl: "Host URL in messages",
      publicUrlHint: "Optional. Adds an Open at line so the message points back at this harness.",
      maxChars: "Max characters",
      maxCharsHint: "A longer message is truncated with an ellipsis.",
      enabled: "Enabled",
      notifyQuestion: "Notify on questions",
      notifyQuestionHint: "Pushes every ask_user_question with its full option list.",
      notifyApproval: "Notify on approvals",
      notifyApprovalHint: "Pushes every approval request.",
      notifyError: "Notify on failed turns",
      notifyErrorHint: "Pushes only failed turns. Successful turns stay silent.",
      save: "Save",
      saving: "Saving...",
      sendTest: "Send test",
      sending: "Sending...",
      clear: "Clear",
      reload: "Reload",
      saved: "Configuration saved",
      testOk: "Test message sent",
      failedToLoad: "Failed to load the configuration",
      failedToSave: "Failed to save the configuration",
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

    const styles = {
      root: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 0 8px" },
      intro: { margin: "0", color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "1.6" },
      field: { display: "flex", flexDirection: "column", gap: "6px" },
      label: { color: "var(--dsw-alias-label-primary)", fontSize: "13px", fontWeight: 500 },
      hint: { margin: "0", color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "1.5" },
      input: {
        boxSizing: "border-box",
        width: "100%",
        height: "34px",
        padding: "0 12px",
        border: "0.5px solid var(--dsw-alias-border-l1)",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: "13px"
      },
      row: { display: "flex", alignItems: "center", gap: "8px" },
      check: { display: "flex", alignItems: "flex-start", gap: "8px" },
      checkText: { display: "flex", flexDirection: "column", gap: "2px" },
      badge: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: "12px",
        border: "0.5px solid var(--dsw-alias-border-l1)",
        borderRadius: "999px",
        padding: "1px 8px"
      },
      actions: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      button: {
        height: "32px",
        padding: "0 14px",
        border: "0.5px solid var(--dsw-alias-border-l1)",
        borderRadius: "8px",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: "13px",
        cursor: "pointer"
      },
      primary: {
        height: "32px",
        padding: "0 14px",
        border: "0.5px solid var(--dsw-alias-bg-accent)",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-accent)",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: "13px",
        cursor: "pointer"
      },
      note: { margin: "0", fontSize: "12px", lineHeight: "1.5", color: "var(--dsw-alias-label-secondary)" },
      error: { margin: "0", fontSize: "12px", lineHeight: "1.5", color: "var(--dsw-alias-label-error)" }
    };

    /** One labelled text input. */
    function Field(props) {
      return h("div", { style: styles.field },
        h("label", { style: styles.label }, props.label),
        h("input", {
          style: styles.input,
          type: props.type ?? "text",
          value: props.value,
          placeholder: props.placeholder,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value)
        }),
        props.hint === undefined ? null : h("p", { style: styles.hint }, props.hint));
    }

    /** One labelled checkbox with supporting text. */
    function Toggle(props) {
      return h("div", { style: styles.check },
        h("input", {
          type: "checkbox",
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked)
        }),
        h("div", { style: styles.checkText },
          h("span", { style: styles.label }, props.label),
          props.hint === undefined ? null : h("span", { style: styles.hint }, props.hint)));
    }

    /**
     * The settings form for one resolved configuration view.
     *
     * This half is pure: it reads `view` and reports edits through callbacks, so
     * the container below it owns the only state there is. That split is what
     * `test/client-smoke.mjs` exercises without a browser.
     *
     * @param props - the configuration view, the staged credentials, and the actions.
     * @returns the form element tree.
     */
    function Form(props) {
      const view = props.view;
      const busy = props.busy === true;
      const badge = h("span", { style: styles.badge },
        view.webhookConfigured === true ? MESSAGES.webhookStored : MESSAGES.webhookMissing);
      return h("div", { style: styles.root },
        h("p", { style: styles.intro }, MESSAGES.intro),
        h("div", { style: styles.row },
          h("label", { style: styles.label }, MESSAGES.webhook),
          badge),
        h("input", {
          style: styles.input,
          type: "text",
          value: props.webhookUrl,
          placeholder: MESSAGES.webhookPlaceholder,
          disabled: busy,
          onChange: (event) => props.onWebhookUrl(event.target.value)
        }),
        h("p", { style: styles.hint }, MESSAGES.webhookHint),
        h(Field, {
          label: MESSAGES.secret,
          type: "password",
          value: props.secret,
          placeholder: MESSAGES.secretPlaceholder,
          hint: MESSAGES.secretHint,
          disabled: busy,
          onChange: props.onSecret
        }),
        h(Field, {
          label: MESSAGES.prefix,
          value: view.prefix ?? "",
          hint: MESSAGES.prefixHint,
          disabled: busy,
          onChange: (value) => props.onDraft({ prefix: value })
        }),
        h(Field, {
          label: MESSAGES.publicUrl,
          value: view.publicUrl ?? "",
          hint: MESSAGES.publicUrlHint,
          disabled: busy,
          onChange: (value) => props.onDraft({ publicUrl: value })
        }),
        h(Field, {
          label: MESSAGES.maxChars,
          value: String(view.maxChars ?? 1800),
          hint: MESSAGES.maxCharsHint,
          disabled: busy,
          onChange: (value) => {
            const parsed = Number.parseInt(value, 10);
            props.onDraft({ maxChars: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1800 });
          }
        }),
        h(Toggle, {
          label: MESSAGES.enabled,
          checked: view.enabled === true,
          disabled: busy,
          onChange: (value) => props.onDraft({ enabled: value })
        }),
        h(Toggle, {
          label: MESSAGES.notifyQuestion,
          hint: MESSAGES.notifyQuestionHint,
          checked: view.notifyQuestion === true,
          disabled: busy,
          onChange: (value) => props.onDraft({ notifyQuestion: value })
        }),
        h(Toggle, {
          label: MESSAGES.notifyApproval,
          hint: MESSAGES.notifyApprovalHint,
          checked: view.notifyApproval === true,
          disabled: busy,
          onChange: (value) => props.onDraft({ notifyApproval: value })
        }),
        h(Toggle, {
          label: MESSAGES.notifyError,
          hint: MESSAGES.notifyErrorHint,
          checked: view.notifyError === true,
          disabled: busy,
          onChange: (value) => props.onDraft({ notifyError: value })
        }),
        h("div", { style: styles.actions },
          h("button", { type: "button", style: styles.primary, disabled: busy, onClick: props.onSave },
            busy ? MESSAGES.saving : MESSAGES.save),
          h("button", { type: "button", style: styles.button, disabled: busy, onClick: props.onTest },
            busy ? MESSAGES.sending : MESSAGES.sendTest),
          h("button", { type: "button", style: styles.button, disabled: busy, onClick: props.onClear },
            MESSAGES.clear),
          h("button", { type: "button", style: styles.button, disabled: busy, onClick: props.onReload },
            MESSAGES.reload)),
        props.error.length > 0 ? h("p", { style: styles.error }, props.error) : null,
        props.note.length > 0 ? h("p", { style: styles.note }, props.note) : null);
    }

    /**
     * The settings section container: loads the view and wires the actions.
     *
     * @param props - the injected controller.
     * @returns the section element tree.
     */
    function FeishuBeaconSection(props) {
      const ctrl = props.controller;
      const [view, setView] = React.useState(null);
      const [webhookUrl, setWebhookUrl] = React.useState("");
      const [secret, setSecret] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [note, setNote] = React.useState("");

      const settleView = (next) => {
        setView(next);
        setWebhookUrl("");
        setSecret("");
      };

      const load = () => {
        setError("");
        return ctrl.load().then(settleView, (cause) => setError(String(cause?.message ?? cause)));
      };

      React.useEffect(() => {
        load();
      }, []);

      if (view === null) {
        return h("div", { style: styles.root },
          h("p", { style: styles.intro }, MESSAGES.intro),
          h("p", { style: styles.note }, error.length > 0 ? error : MESSAGES.failedToLoad));
      }

      return h(Form, {
        view,
        busy,
        error,
        note,
        webhookUrl,
        secret,
        onWebhookUrl: setWebhookUrl,
        onSecret: setSecret,
        onDraft: (patch) => setView({ ...view, ...patch }),
        onReload: load,
        onSave: () => {
          setBusy(true);
          setError("");
          setNote("");
          ctrl.update({
            enabled: view.enabled,
            prefix: view.prefix ?? "",
            publicUrl: view.publicUrl ?? "",
            maxChars: view.maxChars,
            notifyQuestion: view.notifyQuestion,
            notifyApproval: view.notifyApproval,
            notifyError: view.notifyError,
            webhookUrl,
            secret
          }).then(
            (result) => {
              settleView(result?.config ?? view);
              setBusy(false);
              setNote(MESSAGES.saved);
            },
            (cause) => {
              setBusy(false);
              setError(String(cause?.message ?? cause) || MESSAGES.failedToSave);
            }
          );
        },
        onTest: () => {
          setBusy(true);
          setError("");
          setNote("");
          ctrl.test(webhookUrl.length > 0 ? { webhookUrl, secret } : {}).then(
            (result) => {
              setBusy(false);
              setNote(result?.message ?? MESSAGES.testOk);
            },
            (cause) => {
              setBusy(false);
              setError(String(cause?.message ?? cause));
            }
          );
        },
        onClear: () => {
          setBusy(true);
          setError("");
          setNote("");
          ctrl.update({ clearWebhook: true }).then(
            (result) => {
              settleView(result?.config ?? view);
              setBusy(false);
              setNote(MESSAGES.saved);
            },
            (cause) => {
              setBusy(false);
              setError(String(cause?.message ?? cause) || MESSAGES.failedToSave);
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
