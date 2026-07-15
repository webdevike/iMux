// Bridge to the long-lived `omp --mode rpc` child the iMux Swift host owns for
// the Eva provider. Ported from eva-app's `src/omp.ts` (the Tauri invoke/Channel
// surface) and `src-tauri/src/omp.rs` (the JSONL wire parser + tool-title
// derivation + tail-truncation), re-implemented over the iMux agent-session
// bridge instead of Tauri:
//   - callNative("provider.start" | "provider.writeLine" | "provider.stop", …)
//   - subscribeToAgentEvents(…) for provider.started / provider.output /
//     provider.exit frames.
// The exported surface (connectOmp / sendPrompt / respondUi / getMessages /
// restartOmp) matches eva-app 1:1 so the ported <App/> consumes it unchanged.
import { callNative, subscribeToAgentEvents } from "../agent-session/shared/bridge";

// Mirrors the Rust OmpEvent serde output exactly (see eva-app src/omp.ts):
// #[serde(tag = "event", content = "data", rename_all = "camelCase",
//         rename_all_fields = "camelCase")].
export type OmpEvent =
  | { event: "ready" }
  | { event: "delta"; data: { text: string } }
  | { event: "turnEnded" }
  | { event: "toolStart"; data: { id: string; name: string; title: string } }
  | { event: "toolEnd"; data: { id: string; ok: boolean; output: string } }
  | {
      event: "needsInput";
      data: {
        id: string;
        method: string;
        title: string | null;
        message: string | null;
        placeholder: string | null;
      };
    }
  | { event: "restarting"; data: { attempt: number; delayMs: number } }
  | { event: "fatal"; data: { message: string } }
  | { event: "exited"; data: { code: number | null } }
  | { event: "error"; data: { message: string } };

/**
 * Normalized transcript item for session resume (OMP-03). Deferred for MVP —
 * `getMessages` returns `[]` — but the shape is kept so the ported <App/>
 * hydrate path type-checks unchanged.
 */
export type HistItem =
  | { kind: "msg"; role: "user" | "assistant" | "system"; text: string }
  | { kind: "tool"; id: string; name: string; title: string; ok: boolean; output: string };

const PROVIDER_ID = "eva";

// Keep-tail cap for tool output (D-04), ported from omp.rs `OUTPUT_CAP`: omp can
// emit >200 KB single lines, so cap here before it reaches the transcript.
const OUTPUT_CAP = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `unknown` -> record view; arrays/objects pass, primitives/null -> undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  // Guarded structural narrowing (never `any`): after this check `value` is a
  // non-null object, safe to read as a string-keyed bag of `unknown`.
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** `unknown` -> string, else undefined (mirrors serde_json `.as_str()`). */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Keep the LAST `cap` bytes of `s` (snapped up to a UTF-8 char boundary) behind
 * a one-line marker; short strings pass through unchanged. Faithful port of
 * omp.rs `truncate_tail` — the informative tail (errors, exit summary) is kept.
 * Uses byte length (JS string length is UTF-16 units, not bytes).
 */
function truncateTail(s: string, cap = OUTPUT_CAP): string {
  const bytes = encoder.encode(s);
  const total = bytes.length;
  if (total <= cap) return s;
  let start = total - cap;
  // Skip UTF-8 continuation bytes (0b10xxxxxx) so we land on a char boundary.
  while (start < total && (bytes[start] & 0xc0) === 0x80) start += 1;
  const tail = decoder.decode(bytes.subarray(start));
  const tailLen = total - start;
  return `… (truncated, showing last ${tailLen} of ${total} bytes)\n${tail}`;
}

/**
 * Derive the D-01 one-liner for a tool row — never raw JSON. Faithful port of
 * omp.rs `tool_title`: match on the tool name, fall back to the human `intent`,
 * then the bare name; newlines stripped, length capped ~100 chars.
 */
function toolTitle(name: string, args: Record<string, unknown>, intent?: string): string {
  const basename = (key: string): string => {
    const value = asString(args[key]) ?? "";
    const parts = value.split(/[/\\]/);
    return parts[parts.length - 1] ?? "";
  };
  let raw: string;
  switch (name) {
    case "bash":
      raw = `$ ${asString(args.command) ?? ""}`;
      break;
    case "read":
      raw = `Read ${basename("path")}`;
      break;
    case "write":
      raw = `Wrote ${basename("path")}`;
      break;
    case "edit":
      raw = `Edited ${basename("path")}`;
      break;
    case "grep":
      raw = `grep ${asString(args.pattern) ?? ""}`;
      break;
    case "glob":
      raw = asString(args.pattern) ?? "";
      break;
    // cmux host tools (CMUX-06): Eva-native one-liners so the raw cmux_* symbol
    // never surfaces in a tool row. Host tools are not registered for the iMux
    // MVP, but the mapping is ported verbatim for fidelity.
    case "cmux_workspace_create":
      raw = "cmux: create workspace";
      break;
    case "cmux_surface_create":
      raw = "cmux: create surface";
      break;
    case "cmux_send_text":
      raw = "cmux: send text";
      break;
    case "cmux_read_text":
      raw = "cmux: read surface";
      break;
    default:
      raw = intent ?? name;
  }
  const oneLine = raw.replace(/[\n\r]/g, " ");
  const chars = Array.from(oneLine);
  if (chars.length > 100) return `${chars.slice(0, 99).join("")}…`;
  return oneLine;
}

/**
 * Tolerant JSONL parser (RESEARCH.md Pattern 3), ported from omp.rs
 * `parse_omp_line`: maps ONE raw omp stdout line to an OmpEvent. Unknown event
 * types and malformed input map to `null` — never a throw, never a panic.
 */
export function parseOmpLine(line: string): OmpEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const v = asRecord(parsed);
  if (!v) return null;
  const type = asString(v.type);
  if (type === undefined) return null;
  switch (type) {
    case "ready":
      return { event: "ready" };
    case "message_update": {
      const ev = asRecord(v.assistantMessageEvent);
      // text_start / text_end / thinking / toolcall variants are ignored here.
      if (!ev || ev.type !== "text_delta") return null;
      const text = asString(ev.delta);
      if (text === undefined) return null;
      return { event: "delta", data: { text } };
    }
    case "agent_end":
      return { event: "turnEnded" };
    case "tool_execution_start": {
      const id = asString(v.toolCallId);
      if (id === undefined) return null;
      const name = asString(v.toolName) ?? "tool";
      // Arg object is under `args` (live) — NOT `arguments` (the doc field).
      const args = asRecord(v.args) ?? {};
      const title = toolTitle(name, args, asString(v.intent));
      return { event: "toolStart", data: { id, name, title } };
    }
    case "tool_execution_end": {
      const id = asString(v.toolCallId);
      if (id === undefined) return null;
      const ok = v.isError !== true;
      const result = asRecord(v.result);
      const content = result ? result.content : undefined;
      let text = "";
      if (Array.isArray(content)) {
        text = content.map((entry) => asString(asRecord(entry)?.text) ?? "").join("");
      }
      // Cap before it reaches the transcript (D-04).
      return { event: "toolEnd", data: { id, ok, output: truncateTail(text) } };
    }
    case "extension_ui_request": {
      const method = asString(v.method);
      if (method === undefined) return null;
      // Blocking dialog methods need a reply on stdin -> needs-input (D-08, Q1).
      if (
        method === "confirm" ||
        method === "input" ||
        method === "select" ||
        method === "editor" ||
        method === "open_url"
      ) {
        const id = asString(v.id);
        if (id === undefined) return null;
        return {
          event: "needsInput",
          data: {
            id,
            method,
            title: asString(v.title) ?? null,
            message: asString(v.message) ?? null,
            placeholder: asString(v.placeholder) ?? null,
          },
        };
      }
      // setWidget / notify / setStatus / setTitle / set_editor_text: fire-and-forget.
      return null;
    }
    case "response":
      // Failed command results surface as a typed Error carrying omp's message.
      if (v.success === false) {
        return { event: "error", data: { message: asString(v.error) ?? "omp command failed" } };
      }
      return null;
    default:
      // Tolerate everything else — unrequested events arrive (verified live).
      return null;
  }
}

type EventHandler = (event: OmpEvent) => void;

// One omp child per Eva panel (the Swift coordinator owns exactly one session),
// so a single module-level session id is sufficient.
let activeSessionId: string | null = null;
let unsubscribe: (() => void) | null = null;

/** The surface's working directory as the host resolved it (already ~-expanded). */
async function resolveWorkingDirectory(): Promise<string | undefined> {
  try {
    const context = await callNative<{ workingDirectory?: string }>("app.context");
    const workingDirectory = asString(context?.workingDirectory);
    return workingDirectory && workingDirectory.length > 0 ? workingDirectory : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start the eva provider child and capture its session id. When the host can
 * report a working directory we forward it; otherwise we omit it so the host
 * falls back to the coordinator's own (CLI-provided, already-expanded) cwd —
 * never a literal unexpanded "~/…" the Swift side would mis-resolve.
 */
async function startProvider(): Promise<void> {
  const workingDirectory = await resolveWorkingDirectory();
  const params: Record<string, unknown> = { providerId: PROVIDER_ID };
  if (workingDirectory) params.workingDirectory = workingDirectory;
  const reply = await callNative<{ sessionId: string }>("provider.start", params);
  activeSessionId = reply.sessionId;
}

/**
 * Start + subscribe. Mirrors eva-app `connectOmp`: subscribe BEFORE start so the
 * omp `ready` frame is never missed, capturing our session id from either
 * provider.start's reply or the provider.started event (whichever lands first).
 * Each raw stdout line is parsed and forwarded; provider.exit maps to `exited`.
 */
export async function connectOmp(onEvent: EventHandler): Promise<void> {
  unsubscribe?.();
  unsubscribe = subscribeToAgentEvents((event) => {
    switch (event.type) {
      case "provider.started":
        if (activeSessionId === null) activeSessionId = event.sessionId;
        return;
      case "provider.output": {
        if (event.sessionId !== activeSessionId || event.stream !== "stdout") return;
        // Host emits one raw JSONL line per event; split defensively (a JSONL
        // line never contains a literal newline — newlines inside JSON strings
        // are escaped) and skip blanks.
        for (const line of event.text.split("\n")) {
          if (line.trim().length === 0) continue;
          const parsed = parseOmpLine(line);
          if (parsed) onEvent(parsed);
        }
        return;
      }
      case "provider.exit":
        if (event.sessionId !== activeSessionId) return;
        onEvent({ event: "exited", data: { code: event.status } });
        return;
      default:
        return;
    }
  });
  await startProvider();
}

/** Send a user prompt as a raw omp `prompt` command line. */
export async function sendPrompt(message: string): Promise<void> {
  if (activeSessionId === null) throw new Error("Eva is not connected.");
  await callNative("provider.writeLine", {
    sessionId: activeSessionId,
    text: JSON.stringify({ id: crypto.randomUUID(), type: "prompt", message }),
  });
}

/**
 * Reply to a blocking `needsInput` dialog (D-08). Even a `cancelled:true` default
 * unblocks the dialog so a skill can never hang the panel (Pitfall 13).
 */
export async function respondUi(
  id: string,
  opts: { value?: string; confirmed?: boolean; cancelled?: boolean },
): Promise<void> {
  if (activeSessionId === null) throw new Error("Eva is not connected.");
  await callNative("provider.writeLine", {
    sessionId: activeSessionId,
    text: JSON.stringify({ type: "extension_ui_response", id, ...opts }),
  });
}

/** Manually re-spawn omp after a fatal crash (OMP-04): stop (best-effort) + start. */
export async function restartOmp(): Promise<void> {
  const previous = activeSessionId;
  activeSessionId = null;
  if (previous !== null) {
    try {
      await callNative("provider.stop", { sessionId: previous });
    } catch {
      // Best-effort: a dead child may already be gone; the fresh start is what matters.
    }
  }
  await startProvider();
}

/** Session-resume hydration is deferred for MVP — no prior transcript to replay. */
export async function getMessages(): Promise<HistItem[]> {
  return [];
}
