// Session model pinning for API turns (DOM-free, unit-tested in
// test/model-pin.test.mjs).
//
// When the agent advertises `session_model_lock`, the Chat panel pins the
// session's model with POST /api/sessions/{id}/model whenever the model it
// wants (smart routing's tier pick, or the configured default) differs from
// what the session is pinned to, and then sends turns without a per-turn
// `model`. The agent persists the lock on the session, so the choice survives
// reconnects and shows up in the session's runtime metadata. Agents without
// the capability, or a pin the agent refuses, fall back to passing `model`
// and `provider` on the turn as before.

const keyOf = (model, provider) => `${provider || ""}\u0000${model}`;

/**
 * createModelPinner({ pin }) where `pin(session, {model, provider})` resolves
 * {ok, runtime?} or {ok:false, code, error} and never throws.
 *
 * pinner.prepare({ status, session, model, provider }) resolves
 *   { model, provider, pinned, changed, error? }
 * `model`/`provider` are what the turn body should carry (undefined when the
 * session lock covers it). `changed` is true when a new pin was set this call;
 * `error` explains a refused pin (the turn then falls back to per-turn model).
 */
export function createModelPinner({ pin }) {
  const pinned = new Map();   // session -> key of the model the agent has locked
  const refused = new Map();  // session -> key the agent refused (don't retry every turn)
  return {
    async prepare({ status, session, model, provider }) {
      const perTurn = { model: model || undefined, provider: provider || undefined, pinned: false, changed: false };
      if (!model || !session || !status?.modelLock) return perTurn;
      const key = keyOf(model, provider);
      if (pinned.get(session) === key) return { model: undefined, provider: undefined, pinned: true, changed: false };
      if (refused.get(session) === key) return perTurn;
      const r = await pin(session, { model, ...(provider ? { provider } : {}) });
      if (r?.ok) {
        pinned.set(session, key);
        refused.delete(session);
        return { model: undefined, provider: undefined, pinned: true, changed: true };
      }
      pinned.delete(session);
      refused.set(session, key);
      return { ...perTurn, error: r?.error || r?.code || "pin failed" };
    },
    /** Current pin for a session as {model, provider} or null. */
    current(session) {
      const k = pinned.get(session);
      if (k == null) return null;
      const i = k.indexOf("\u0000");
      return { provider: k.slice(0, i) || undefined, model: k.slice(i + 1) };
    },
    /** Forget a session's pin (e.g. the agent restarted against a fresh store). */
    forget(session) { pinned.delete(session); refused.delete(session); },
  };
}
