import { readFile } from "node:fs/promises";
import { NanoodleError, RunError, UnsupportedNodeError } from "./errors.mjs";
import { NODE_TYPES, displayName, isInputPort, materialize, topoSort } from "./graph.mjs";
import { deriveInputs, deriveOutputs, deriveSettings, resolveInputKey, resolveSettingKey } from "./io.mjs";
import { NanoClient } from "./client.mjs";
import { MediaRef, coerceMediaInput } from "./media.mjs";
import { RUNNERS, unsupportedNodeError } from "./nodes.mjs";

const MEDIA_KINDS = new Set(["image", "audio", "video", "inpaint"]);

/** The outcome of Workflow.run(). Media values are MediaRef; text values plain strings. */
export class RunResult {
  constructor({ outputs, nodes, errors, costUsd, costExact, remainingBalance }) {
    /** { [friendlyKey | nodeId]: value } — sink node primary outputs */
    this.outputs = outputs;
    /** per-node { status: "done"|"error"|"skipped", out, error, costUsd, ms } */
    this.nodes = nodes;
    /** [{ nodeId, name, message }] for every node that failed (incl. non-sink warnings) */
    this.errors = errors;
    /** summed USD cost of all calls that reported one */
    this.costUsd = costUsd;
    /** false when any network call omitted its price (total is a floor) */
    this.costExact = costExact;
    /** last remaining-balance the API reported, or null */
    this.remainingBalance = remainingBalance;
  }

  /** Output lookup by friendly key or node id (case-insensitive). */
  get(key) {
    // own-key check: `in` would leak Object.prototype members (get("toString") → a function)
    if (Object.hasOwn(this.outputs, key)) return this.outputs[key];
    const norm = String(key).trim().toLowerCase();
    for (const k of Object.keys(this.outputs)) {
      if (k.toLowerCase() === norm) return this.outputs[k];
    }
    throw new NanoodleError(`no output "${key}" — available outputs: ${Object.keys(this.outputs).map((k) => `"${k}"`).join(", ") || "(none)"}`);
  }
}

function isPlainObject(v) {
  if (v == null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export class Workflow {
  /**
   * @param {object} graphData parsed noodle-graph.json
   * @param {{ apiKey?, baseUrl?, fetch?, pollIntervals?, timeouts?, quiet? }} [opts]
   */
  constructor(graphData, opts = {}) {
    const { nodes, links, warnings } = materialize(graphData);
    this.graph = { nodes, links };
    /** Load-time warnings (unknown / unsupported node types). load() only warns; run() fails fast. */
    this.warnings = warnings;
    this.client = new NanoClient({
      apiKey: opts.apiKey !== undefined ? opts.apiKey : process.env.NANOGPT_API_KEY,
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      pollIntervals: opts.pollIntervals,
      timeouts: opts.timeouts,
    });
    /** [{ key, nodeId, field, kind, label, optional, def, options? }] */
    this.inputs = deriveInputs(this.graph);
    /** [{ key, nodeId, type, ports }] */
    this.outputs = deriveOutputs(this.graph);
    /** [{ key, nodeId, field, kind, def, options? }] */
    this.settings = deriveSettings(this.graph);
    if (warnings.length && !opts.quiet) {
      for (const w of warnings) process.emitWarning(w, { code: "NANOODLE_GRAPH" });
    }
  }

  /** Load a downloaded noodle-graph.json save from disk. */
  static async load(path, opts = {}) {
    return Workflow.fromJSON(await readFile(path, "utf8"), opts);
  }

  /** Build from a parsed object or a JSON string. */
  static fromJSON(objOrString, opts = {}) {
    const data = typeof objOrString === "string" ? JSON.parse(objOrString) : objOrString;
    return new Workflow(data, opts);
  }

  /**
   * Execute the whole graph.
   * @param {object|string|Uint8Array|MediaRef} inputs friendly-keyed values, or a bare scalar
   *   when the workflow has exactly one required input
   * @param {{ settings?, timeoutMs?, signal?, onProgress? }} [runOpts]
   * @returns {Promise<RunResult>} rejects with RunError (carrying .result) when a sink failed
   */
  async run(inputs = {}, runOpts = {}) {
    const { settings = {}, timeoutMs, signal, onProgress } = runOpts;
    const graph = this.graph;

    // bare scalar → the single required input
    if (!isPlainObject(inputs)) {
      const required = this.inputs.filter((i) => !i.optional);
      if (required.length !== 1) {
        throw new NanoodleError(
          `a bare input value needs exactly one required input; this workflow has ${required.length} ` +
          `(${required.map((i) => `"${i.key}"`).join(", ")}) — pass an object instead`);
      }
      inputs = { [required[0].key]: inputs };
    }

    // ---- upfront validation: resolve every key BEFORE running/spending anything ----
    const inputAssignments = [];
    for (const [key, value] of Object.entries(inputs)) {
      const entry = resolveInputKey(graph, this.inputs, key);
      inputAssignments.push({ entry, value });
    }
    const settingAssignments = [];
    for (const [key, value] of Object.entries(settings)) {
      const entry = resolveSettingKey(graph, this.settings, key);
      settingAssignments.push({ entry, value });
    }

    // unsupported / unknown node types fail fast — before any network call
    for (const n of graph.nodes) {
      if (n.unknown) {
        throw new UnsupportedNodeError(
          `node ${n.id}: unknown node type '${n.type}' — this graph needs a newer nanoodle library`,
          { nodeId: n.id, nodeType: n.type });
      }
      if (NODE_TYPES[n.type].unsupported) throw unsupportedNodeError(n);
    }

    const order = topoSort(graph); // throws naming cyclic nodes

    // effective fields: graph fields + settings overrides + user inputs
    const effFields = new Map(graph.nodes.map((n) => [n.id, { ...n.fields }]));
    for (const { entry, value } of settingAssignments) {
      effFields.get(entry.nodeId)[entry.field] = this._coerceSetting(entry, value);
    }
    const explicit = new Set();
    for (const { entry, value } of inputAssignments) {
      effFields.get(entry.nodeId)[entry.field] = this._coerceInput(entry, value);
      explicit.add(entry);
    }
    // defaults + required check
    for (const entry of this.inputs) {
      const fields = effFields.get(entry.nodeId);
      const v = fields[entry.field];
      if (v == null || String(v).trim() === "") {
        // an EXPLICIT empty value clears an optional input (e.g. run with no system prompt) —
        // the def only backfills when the key wasn't supplied at all (the app's prefilled textarea)
        if (entry.optional && explicit.has(entry)) continue;
        if (entry.def != null && String(entry.def) !== "") fields[entry.field] = entry.def;
        else if (!entry.optional) {
          throw new NanoodleError(`missing required input "${entry.key}" (${entry.nodeId}.${entry.field})`);
        }
      }
    }

    // API key required only when the graph actually calls NanoGPT
    if (!this.client.apiKey && graph.nodes.some((n) => NODE_TYPES[n.type].network)) {
      throw new NanoodleError("no API key — pass { apiKey } to Workflow.load/fromJSON or set NANOGPT_API_KEY (this workflow calls the NanoGPT API)");
    }

    // ---- execution ----
    const ac = new AbortController();
    let timer = null;
    const onOuterAbort = () => ac.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason);
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    if (timeoutMs) {
      timer = setTimeout(() => ac.abort(new NanoodleError(`run timed out after ${timeoutMs}ms`, { code: "timeout" })), timeoutMs);
    }

    const emit = (evt) => { if (onProgress) { try { onProgress(evt); } catch { /* listener errors never kill the run */ } } };
    const nodesRec = {};
    const errors = [];
    const cost = { total: 0, exact: true, balance: null };
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const promises = new Map();

    const ctxFor = (node, rec) => {
      const onCost = (c) => {
        if (!c) return;
        if (c.usd != null) { rec.costUsd = (rec.costUsd || 0) + c.usd; cost.total += c.usd; }
        else cost.exact = false;
        if (c.balance != null) cost.balance = c.balance;
      };
      const onPoll = (info) => emit({ type: "poll", nodeId: node.id, name: displayName(node), ...info });
      const io = { onCost, onPoll, signal: ac.signal };
      return {
        chat: (messages, model, opts) => this.client.chat(messages, model, opts, io),
        chatImage: (messages, model, opts) => this.client.chatImage(messages, model, opts, io),
        image: (args) => this.client.image(args, io),
        video: (model, prompt, opts, imageDataUrl) => this.client.video(model, prompt, opts, imageDataUrl, io),
        audio: (model, input, extra) => this.client.audio(model, input, extra, io),
        transcribe: (model, audioUrl, language) => this.client.transcribe(model, audioUrl, language, io),
        fetchMedia: (url) => this.client.fetchMediaDataUrl(url, io),
      };
    };

    const execNode = async (n) => {
      const rec = nodesRec[n.id];
      try {
        const inbound = graph.links.filter((l) => l.to.node === n.id);
        const inp = {};
        let fields = effFields.get(n.id);
        let upstreamFail = null;
        for (const l of inbound) {
          let srcOut;
          try { srcOut = await promises.get(l.from.node); }
          catch { if (!upstreamFail) upstreamFail = displayName(byId.get(l.from.node)); continue; }
          const v = srcOut[l.from.port];
          if (isInputPort(n, l.to.port)) inp[l.to.port] = v;
          // wired textarea port = field override; a missing upstream port (degraded save) must
          // NOT clobber the typed field with undefined — the app only applies v != null
          else if (v != null) fields = { ...fields, [l.to.port]: v };
        }
        if (upstreamFail) throw new NanoodleError("upstream failed: " + upstreamFail);
        emit({ type: "node-start", nodeId: n.id, name: displayName(n) });
        const t0 = Date.now();
        const out = await RUNNERS[n.type]({ ...n, fields }, inp, ctxFor(n, rec));
        rec.status = "done";
        rec.out = out;
        rec.ms = Date.now() - t0;
        emit({ type: "node-done", nodeId: n.id, name: displayName(n), ms: rec.ms, costUsd: rec.costUsd });
        return out;
      } catch (e) {
        rec.status = "error";
        rec.error = e.message;
        errors.push({ nodeId: n.id, name: displayName(n), message: e.message });
        emit({ type: "node-error", nodeId: n.id, name: displayName(n), error: e.message });
        throw e;
      }
    };

    try {
      for (const n of order) {
        if (NODE_TYPES[n.type].note) { nodesRec[n.id] = { status: "skipped", out: null, error: null, costUsd: null, ms: null }; continue; }
        nodesRec[n.id] = { status: "pending", out: null, error: null, costUsd: null, ms: null };
        promises.set(n.id, execNode(n)); // siblings run concurrently; a node starts when ITS deps finish
      }
      await Promise.allSettled([...promises.values()]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }

    // ---- result ----
    const outputsMap = {};
    for (const o of this.outputs) {
      const rec = nodesRec[o.nodeId];
      if (!rec || rec.status !== "done") continue;
      const primary = o.ports[0];
      const value = this._wrapValue(rec.out[primary.name], primary.type);
      outputsMap[o.key] = value;
      outputsMap[o.nodeId] = value;
    }
    const result = new RunResult({
      outputs: outputsMap,
      nodes: nodesRec,
      errors,
      costUsd: cost.total,
      costExact: cost.exact,
      remainingBalance: cost.balance,
    });

    const failedSinks = this.outputs.filter((o) => nodesRec[o.nodeId] && nodesRec[o.nodeId].status === "error");
    if (failedSinks.length) {
      const detail = failedSinks.map((o) => `"${o.key}": ${nodesRec[o.nodeId].error}`).join("; ");
      throw new RunError("run failed — " + detail, result);
    }
    return result;
  }

  _coerceInput(entry, value) {
    if (MEDIA_KINDS.has(entry.kind)) {
      return coerceMediaInput(value, `input "${entry.key}"`);
    }
    if (entry.kind === "choice") {
      const v = String(value);
      if (!(entry.options || []).includes(v)) {
        throw new NanoodleError(`input "${entry.key}": "${v}" is not one of the choices (${(entry.options || []).join(", ")})`);
      }
      return v;
    }
    if (value != null && typeof value === "object" && !(value instanceof String)) {
      throw new NanoodleError(`input "${entry.key}" expects text — got ${Array.isArray(value) ? "an array" : "an object"}`);
    }
    return value == null ? value : String(value);
  }

  _coerceSetting(entry, value) {
    // settings come from DOM inputs in the app, so runners assume strings — coerce scalars
    // (numbers/booleans) the same way instead of crashing a runner mid-run
    if (value == null) return value;
    if (typeof value === "object" && !(value instanceof String)) {
      throw new NanoodleError(`setting "${entry.key}" expects a scalar — got ${Array.isArray(value) ? "an array" : "an object"}`);
    }
    return String(value);
  }

  _wrapValue(value, portType) {
    if (portType !== "text" && typeof value === "string" && value) {
      return new MediaRef(value, { fetch: this.client.fetch });
    }
    return value;
  }
}
