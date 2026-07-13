import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { Button, Group, Loader, ScrollArea, Text, TextInput } from "@mantine/core";
import {
  connectOmp,
  getMessages,
  type HistItem,
  type OmpEvent,
  respondUi,
  restartOmp,
  sendPrompt,
} from "./ompClient";
import { Markdown } from "./Markdown";
import { ToolGroup, ToolRow } from "./ToolRow";
import { PresenceOrb, type PresenceState } from "./PresenceOrb";
import { Composer } from "./Composer";

// D-02/D-03: the transcript is a heterogeneous list, not a flat message array —
// assistant/user/system text, tool-activity rows (matching ToolRow's ToolItem
// plus a status field), and a subtle "Resumed" divider on session resume (OMP-03).
type TranscriptItem =
  | { kind: "msg"; role: "user" | "assistant" | "system"; text: string; incomplete?: boolean }
  | { kind: "tool"; id: string; name: string; title: string; status: "running" | "ok" | "error"; output?: string }
  | { kind: "divider"; label: string };

type ChatState = {
  items: TranscriptItem[];
  streaming: boolean;
  ready: boolean;
  // D-08: a blocking dialog awaiting a reply; presence flips to needs-input.
  needsInput: null | { id: string; method: string; title?: string; message?: string; placeholder?: string };
  // OMP-04: omp gave up restarting — a persistent notice + Retry until recovery.
  fatal: null | string;
  // OMP-04: a transient reconnect banner (exited/restarting) cleared on the next
  // ready — distinct from the permanent transcript so it never lingers post-recovery.
  reconnecting: null | string;
};

/**
 * User submissions and lifecycle events enter the reducer alongside streamed omp
 * events: `sent` (a user prompt), `hydrate` (prior transcript on resume, OMP-03),
 * and `uiResponded` (a needs-input dialog was answered, D-08).
 */
type ChatAction =
  | OmpEvent
  | { event: "sent"; text: string }
  | { event: "hydrate"; items: HistItem[] }
  | { event: "uiResponded" };

// D-07: ONE reducer-derived presence value — computed, never stored — read by both
// the titlebar orb and the in-transcript thinking row so they can never diverge.
const presence = (s: ChatState): PresenceState =>
  s.needsInput ? "needs-input" : s.streaming ? "working" : "idle";

// SHELL-02: time-of-day greeting for the empty-state hero. A pure band over the
// local hour (05-RESEARCH Finding 6) — recomputed each render, no timer, no lib.
function greeting(name: string, h = new Date().getHours()): string {
  if (h >= 5 && h < 12) return `Good morning, ${name}`;
  if (h >= 12 && h < 17) return `Good afternoon, ${name}`;
  if (h >= 17 && h < 22) return `Good evening, ${name}`;
  return `Still up, ${name}?`;
}

// D-07: the thinking row shows between send and the first delta/tool row — i.e.
// streaming with no assistant text and no tool item produced yet this turn. The
// first delta/toolStart lands an item after the turn's user msg, ending it.
function showThinkingRow(s: ChatState): boolean {
  if (!s.streaming) return false;
  let lastUser = -1;
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === "msg" && it.role === "user") {
      lastUser = i;
      break;
    }
  }
  for (let i = lastUser + 1; i < s.items.length; i++) {
    const it = s.items[i];
    if (it.kind === "tool") return false;
    if (it.kind === "msg" && it.role === "assistant") return false;
  }
  return true;
}

// OMP-04: keep the half-streamed reply visible but mark it interrupted — the
// in-flight turn is marked failed, never dropped.
function markLastAssistantIncomplete(items: TranscriptItem[]): TranscriptItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "msg" && it.role === "assistant") {
      const copy = items.slice();
      copy[i] = { ...it, incomplete: true };
      return copy;
    }
  }
  return items;
}

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.event) {
    case "sent":
      return {
        ...state,
        streaming: true,
        items: [...state.items, { kind: "msg", role: "user", text: action.text }],
      };
    case "ready":
      // Prompts written before the ready frame are acked but silently dropped
      // (live-verified in plan 01-01) — the composer stays gated until this
      // arrives. Also the recovery signal after a restart: clear fatal + the
      // transient reconnect banner (Q6) so no stale "restarting" notice lingers.
      return { ...state, ready: true, fatal: null, reconnecting: null };
    case "delta": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (state.streaming && last?.kind === "msg" && last.role === "assistant") {
        items[items.length - 1] = { ...last, text: last.text + action.data.text };
      } else {
        // First delta of a turn (or a new chunk after tool rows, D-02) opens a
        // new assistant message — this also ends the thinking row implicitly.
        items.push({ kind: "msg", role: "assistant", text: action.data.text });
      }
      return { ...state, items };
    }
    case "toolStart":
      // D-03: push a running tool row.
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool",
            id: action.data.id,
            name: action.data.name,
            title: action.data.title,
            status: "running",
          },
        ],
      };
    case "toolEnd":
      // D-03: find the row by id, set ok/error and attach the (truncated) output.
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "tool" && it.id === action.data.id
            ? { ...it, status: action.data.ok ? "ok" : "error", output: action.data.output }
            : it,
        ),
      };
    case "needsInput": {
      // D-08: record the dialog (presence flips to needs-input). confirm/input get
      // an inline responder; other methods are surfaced as a system notice and
      // safe-default cancelled by an effect so the turn can never hang (Pitfall 13).
      const ni = {
        id: action.data.id,
        method: action.data.method,
        title: action.data.title ?? undefined,
        message: action.data.message ?? undefined,
        placeholder: action.data.placeholder ?? undefined,
      };
      if (ni.method === "confirm" || ni.method === "input") {
        return { ...state, needsInput: ni };
      }
      const label = [ni.title, ni.message].filter(Boolean).join(" — ") || ni.method;
      return {
        ...state,
        needsInput: ni,
        items: [
          ...state.items,
          { kind: "msg", role: "system", text: `Eva asked (${ni.method}): ${label} — auto-declined` },
        ],
      };
    }
    case "uiResponded":
      return { ...state, needsInput: null };
    case "turnEnded":
      // Busy state keys off streamed events, never the sendPrompt ack (Pitfall 8a).
      return { ...state, streaming: false, needsInput: null };
    case "exited": {
      const code = action.data.code ?? "unknown";
      // A mid-response disconnect leaves the last assistant turn permanently marked
      // incomplete; the reconnect status itself is transient and cleared on ready.
      const items = state.streaming ? markLastAssistantIncomplete(state.items) : state.items;
      const note = state.streaming
        ? `Eva disconnected mid-response (code ${code}) — reconnecting…`
        : `omp exited (code ${code}) — reconnecting…`;
      // No child left to accept prompts until a restart re-emits ready.
      return { ...state, streaming: false, ready: false, items, reconnecting: note };
    }
    case "restarting":
      // Q6: transient banner between backoff attempts; composer stays gated.
      return {
        ...state,
        ready: false,
        reconnecting: `Restarting Eva (attempt ${action.data.attempt})…`,
      };
    case "fatal":
      // OMP-04: supervisor gave up — persistent notice + Retry, composer gated
      // until a ready recovery clears fatal.
      return {
        ...state,
        streaming: false,
        ready: false,
        fatal: action.data.message,
        reconnecting: null,
        items: [
          ...state.items,
          { kind: "msg", role: "system", text: `Eva keeps crashing: ${action.data.message}` },
        ],
      };
    case "error":
      return {
        ...state,
        streaming: false,
        items: [
          ...state.items,
          { kind: "msg", role: "system", text: `omp error: ${action.data.message}` },
        ],
      };
    case "hydrate": {
      // OMP-03: replace the (empty) transcript with the prior one, then a single
      // subtle "Resumed" divider before any live turns.
      if (action.items.length === 0) return state;
      const mapped: TranscriptItem[] = action.items.map((h) =>
        h.kind === "tool"
          ? {
              kind: "tool",
              id: h.id,
              name: h.name,
              title: h.title,
              status: h.ok ? "ok" : "error",
              output: h.output,
            }
          : { kind: "msg", role: h.role, text: h.text },
      );
      return { ...state, items: [...mapped, { kind: "divider", label: "Resumed" }] };
    }
  }
}

const initialState: ChatState = {
  items: [],
  streaming: false,
  ready: false,
  needsInput: null,
  fatal: null,
  reconnecting: null,
};

// confirm/input get an inline responder; every other blocking method is
// safe-default cancelled by an effect (Pitfall 13) after the reducer surfaces it.
const SUPPORTED_METHODS: Record<string, true> = { confirm: true, input: true };

// D-02: render the transcript, clustering CONSECUTIVE tool items into ONE
// <ToolGroup> between assistant text chunks rather than a group per tool.
function renderTranscript(items: TranscriptItem[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === "tool") {
      const group: TranscriptItem[] = [];
      while (i < items.length) {
        const t = items[i];
        if (t.kind !== "tool") break;
        group.push(t);
        i++;
      }
      out.push(
        <div key={`tools-${i}`} className="chat-tools">
          <ToolGroup>
            {group.map((t) => (t.kind === "tool" ? <ToolRow key={t.id} item={t} /> : null))}
          </ToolGroup>
        </div>,
      );
      continue;
    }
    if (it.kind === "divider") {
      out.push(
        <div key={`divider-${i}`} className="chat-divider">
          <span>{it.label}</span>
        </div>,
      );
      i++;
      continue;
    }
    if (it.role === "assistant") {
      // CHAT-03: assistant text through the sanitizing Markdown renderer.
      out.push(
        <div key={`msg-${i}`} className="chat-message chat-message-assistant">
          <Markdown text={it.text} />
          {it.incomplete && (
            <Text component="div" className="chat-incomplete" c="dimmed" fz="xs">
              Eva was interrupted mid-response.
            </Text>
          )}
        </div>,
      );
      i++;
      continue;
    }
    out.push(
      <Text
        key={`msg-${i}`}
        className={`chat-message chat-message-${it.role}`}
        c={it.role === "system" ? "dimmed" : undefined}
        fz={it.role === "system" ? "sm" : undefined}
        style={{ whiteSpace: "pre-wrap" }}
      >
        {it.text}
      </Text>,
    );
    i++;
  }
  return out;
}

function App() {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const viewportRef = useRef<HTMLDivElement>(null);
  const hydratedRef = useRef(false);

  // Runs on every mount — start_omp is idempotent host-side and the bridge
  // subscription is swapped, so re-running is safe (Pitfall 3).
  useEffect(() => {
    connectOmp(dispatch).catch((err) =>
      dispatch({ event: "error", data: { message: String(err) } }),
    );
  }, []);

  // OMP-03: on the first ready, hydrate the prior transcript once. Guarded so a
  // restart recovery (ready flips true again) never re-hydrates. (MVP: getMessages
  // returns [] so this is a no-op until session persistence lands.)
  useEffect(() => {
    if (!state.ready || hydratedRef.current) return;
    hydratedRef.current = true;
    getMessages()
      .then((items) => {
        if (items.length > 0) dispatch({ event: "hydrate", items });
      })
      .catch((err) => dispatch({ event: "error", data: { message: String(err) } }));
  }, [state.ready]);

  // Keep the transcript pinned to the bottom as items arrive.
  useEffect(() => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
  }, [state.items]);

  // Pitfall 13: a blocking dialog we don't render a responder for is safe-default
  // cancelled so the turn can never hang (the reducer already surfaced it).
  useEffect(() => {
    const ni = state.needsInput;
    if (!ni || SUPPORTED_METHODS[ni.method]) return;
    respondUi(ni.id, { cancelled: true }).catch((err) =>
      dispatch({ event: "error", data: { message: String(err) } }),
    );
    dispatch({ event: "uiResponded" });
  }, [state.needsInput]);

  function submit(text: string) {
    dispatch({ event: "sent", text });
    sendPrompt(text).catch((err) =>
      dispatch({ event: "error", data: { message: String(err) } }),
    );
  }

  function reply(opts: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    const ni = state.needsInput;
    if (!ni) return;
    respondUi(ni.id, opts).catch((err) =>
      dispatch({ event: "error", data: { message: String(err) } }),
    );
    dispatch({ event: "uiResponded" });
  }

  // CHAT-05: composer inert while not ready, streaming, awaiting a dialog, or fatal.
  const composerDisabled =
    !state.ready || state.streaming || state.needsInput !== null || state.fatal !== null;

  return (
    <div className="app-shell">
      {/* D-05: presence anchor — non-interactive (pointer-events:none), shows
          Eva's state above the transcript in every view. */}
      <header className="titlebar">
        <PresenceOrb state={presence(state)} />
      </header>
      <main className="app-main">
        <div className="chat">
          <ScrollArea className="chat-transcript" viewportRef={viewportRef}>
            <div className="chat-messages">
              {state.items.length === 0 && (
                <div className="chat-hero">
                  <PresenceOrb state={presence(state)} />
                  <Text className="chat-greeting">{greeting("Isaac")}</Text>
                </div>
              )}
              {renderTranscript(state.items)}
              {/* D-07: thinking row — replaced in place by the first delta/tool row. */}
              {showThinkingRow(state) && (
                <div
                  className="chat-message chat-message-assistant chat-thinking"
                  aria-label="Eva is thinking"
                >
                  <span className="chat-thinking-dot" />
                  <span className="chat-thinking-dot" />
                  <span className="chat-thinking-dot" />
                </div>
              )}
            </div>
          </ScrollArea>

          {/* D-08: inline responder for blocking confirm/input dialogs. */}
          {state.needsInput &&
            (state.needsInput.method === "confirm" || state.needsInput.method === "input") && (
              <NeedsInputResponder
                key={state.needsInput.id}
                needsInput={state.needsInput}
                onReply={reply}
              />
            )}

          {/* OMP-04: transient reconnect banner while omp is exited/restarting;
              cleared automatically on the next ready (fatal supersedes it). */}
          {state.reconnecting && !state.fatal && (
            <div className="chat-reconnecting">
              <Loader size="xs" color="gray" />
              <Text size="sm" c="dimmed">
                {state.reconnecting}
              </Text>
            </div>
          )}

          {/* OMP-04: persistent Fatal notice + Retry; composer stays gated until
              a ready recovery clears fatal. */}
          {state.fatal && (
            <div className="chat-fatal">
              <Text size="sm" c="red">
                {state.fatal}
              </Text>
              <Button
                size="xs"
                color="red"
                variant="light"
                onClick={() =>
                  restartOmp().catch((err) =>
                    dispatch({ event: "error", data: { message: String(err) } }),
                  )
                }
              >
                Retry
              </Button>
            </div>
          )}

          <div className="chat-composer">
            <Composer onSend={submit} disabled={composerDisabled} />
          </div>
        </div>
      </main>
    </div>
  );
}

// D-08/Q1: confirm -> Yes/No; input -> a single-line field + submit. Both reply
// via respondUi (wired through onReply) and clear needs-input.
function NeedsInputResponder({
  needsInput,
  onReply,
}: {
  needsInput: NonNullable<ChatState["needsInput"]>;
  onReply: (opts: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="chat-responder">
      {needsInput.title && (
        <Text fw={600} size="sm">
          {needsInput.title}
        </Text>
      )}
      {needsInput.message && (
        <Text size="sm" c="dimmed">
          {needsInput.message}
        </Text>
      )}
      {needsInput.method === "confirm" ? (
        <Group gap={8}>
          <Button size="xs" onClick={() => onReply({ confirmed: true })}>
            Yes
          </Button>
          <Button size="xs" variant="default" onClick={() => onReply({ confirmed: false })}>
            No
          </Button>
        </Group>
      ) : (
        <form
          className="chat-responder-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = value.trim();
            if (!v) return;
            onReply({ value: v });
          }}
        >
          <TextInput
            className="chat-responder-input"
            size="xs"
            autoFocus
            placeholder={needsInput.placeholder ?? "Your answer"}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
          />
          <Button size="xs" type="submit">
            Send
          </Button>
        </form>
      )}
    </div>
  );
}

export default App;
