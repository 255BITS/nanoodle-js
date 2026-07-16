/**
 * Opt-in model catalog (replace-prep: catalog gates behave like play RUNTIME_JS).
 *
 * Data-only: pass `{ catalog: { chat, image, video, audio } }` to Workflow with
 * the raw arrays the NanoGPT public catalog endpoints return (/api/v1/models,
 * /api/v1/image-models, …) — the library never fetches them itself. Every gate
 * is permissive: no catalog, or a model absent from it, changes nothing, so
 * authored graphs keep their behavior offline. Only a KNOWN-incapable model has
 * the gated part/knob stripped (mirrors play's chatModelCan / rawCatItem).
 */

export function catItem(catalog, kind, id) {
  if (!catalog || !id) return null;
  const raw = catalog[kind];
  return (Array.isArray(raw) && raw.find((m) => m && m.id === id)) || null;
}

/** Permissive capability probe: true unless the model is in the catalog AND lacks the flag. */
export function chatModelCan(catalog, model, flag) {
  const m = catItem(catalog, "chat", model);
  return !m || !!((m.capabilities || {})[flag]);
}
