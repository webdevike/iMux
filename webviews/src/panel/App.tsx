import { Button, MantineProvider, Text, createTheme } from "@mantine/core";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownView } from "./MarkdownView";
import { SectionBlockView, initialSectionState, type SectionUiState } from "./SectionBlockView";
import { TreeBlockView } from "./TreeBlockView";
import { detectBridge, type PanelBridge } from "./bridge";
import { demoInitValue } from "./demoSpec";
import {
  isRecord,
  sanitizeSpec,
  type PanelMode,
  type SanitizedSpec,
  type SectionResult,
  type SubmitValue,
  type TreeNode,
} from "./spec";

const panelTheme = createTheme({
  fontFamily: "var(--panel-font-sans)",
  fontFamilyMonospace: "var(--panel-font-mono)",
  defaultRadius: "sm",
  cursorType: "pointer",
  scale: 0.95,
});

// All spec-derived and user-owned data lives in one object so that an
// app-pushed spec update (`__cmuxPanelApply`) can reconcile it atomically.
type PanelState = {
  title: string;
  spec: SanitizedSpec;
  trees: Record<string, TreeNode[]>;
  sections: Record<string, SectionUiState>;
  /** Block ids the user has locally edited since the spec last provided them. */
  dirty: ReadonlySet<string>;
};

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; state: PanelState };

type Flash = { kind: "sent" | "updated"; nonce: number };

type ApplyPayload = { title?: string; spec: SanitizedSpec };

type ApplyWindow = Window & { __cmuxPanelApply?: (payload: unknown) => boolean };

const FLASH_DURATION_MS = 2400;

type PanelAppProps = {
  /** Injectable for tests; defaults to native-vs-demo detection. */
  bridge?: PanelBridge;
};

export function PanelApp({ bridge }: PanelAppProps) {
  const activeBridge = useMemo(() => bridge ?? detectBridge(window, demoInitValue), [bridge]);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [meta, setMeta] = useState<{ mode: PanelMode; panelId: string }>({ mode: "prompt", panelId: "" });
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [demoSubmitted, setDemoSubmitted] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashNonceRef = useRef(0);
  const phaseRef = useRef<Phase>(phase);
  const pendingApplyRef = useRef<ApplyPayload | null>(null);

  const showFlash = (kind: Flash["kind"]) => {
    flashNonceRef.current += 1;
    setFlash({ kind, nonce: flashNonceRef.current });
  };

  // Applies a stashed app-pushed update once the panel is ready. Uses only
  // refs and stable setters, so any closure instance behaves identically.
  const drainPendingApply = () => {
    const payload = pendingApplyRef.current;
    if (!payload || phaseRef.current.kind !== "ready") {
      return;
    }
    pendingApplyRef.current = null;
    if (payload.title) {
      document.title = payload.title;
    }
    setPhase((previous) =>
      previous.kind === "ready"
        ? { kind: "ready", state: reconcilePanelState(previous.state, payload.title, payload.spec) }
        : previous,
    );
    showFlash("updated");
  };

  useEffect(() => {
    phaseRef.current = phase;
    drainPendingApply();
  });

  useEffect(() => {
    // The app pushes spec updates by calling this global and checks the
    // return value, so it must exist before init completes. `true` means the
    // payload was accepted; a structurally invalid payload is refused.
    const win = window as ApplyWindow;
    win.__cmuxPanelApply = (payload: unknown): boolean => {
      const parsed = parseApplyPayload(payload);
      if (!parsed) {
        return false;
      }
      pendingApplyRef.current = parsed;
      drainPendingApply();
      return true;
    };

    let cancelled = false;
    activeBridge
      .init()
      .then((initValue) => {
        if (cancelled) {
          return;
        }
        const spec = sanitizeSpec(initValue.spec);
        const title = spec.title || initValue.title || "Panel";
        document.title = initValue.title || title;
        setMeta({
          mode: initValue.mode === "live" ? "live" : "prompt",
          panelId: typeof initValue.panelId === "string" ? initValue.panelId : "",
        });
        setPhase({ kind: "ready", state: freshPanelState(title, spec) });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPhase({ kind: "error", message: error instanceof Error ? error.message : "The panel failed to load." });
        }
      });
    return () => {
      cancelled = true;
      delete win.__cmuxPanelApply;
    };
  }, [activeBridge]);

  useEffect(() => {
    if (!flash) {
      return;
    }
    const timer = setTimeout(() => {
      setFlash((current) => (current?.nonce === flash.nonce ? null : current));
    }, FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const updateTree = (id: string, nodes: TreeNode[]) => {
    setPhase((previous) =>
      previous.kind === "ready"
        ? {
            kind: "ready",
            state: {
              ...previous.state,
              trees: { ...previous.state.trees, [id]: nodes },
              dirty: withId(previous.state.dirty, id),
            },
          }
        : previous,
    );
  };

  const updateSection = (id: string, next: SectionUiState) => {
    setPhase((previous) =>
      previous.kind === "ready"
        ? {
            kind: "ready",
            state: {
              ...previous.state,
              sections: { ...previous.state.sections, [id]: next },
              dirty: withId(previous.state.dirty, id),
            },
          }
        : previous,
    );
  };

  const runAction = (action: "submit" | "cancel") => {
    setBusy(action);
    setActionError(null);
    const call = action === "submit" ? activeBridge.submit(collectSubmitValue(phase)) : activeBridge.cancel();
    call
      .then(() => {
        if (action === "submit" && meta.mode === "live") {
          // Live panels keep iterating: re-enable, confirm, and mark the
          // current edits as delivered so the next app update wins over them.
          setBusy(null);
          setPhase((previous) =>
            previous.kind === "ready"
              ? { kind: "ready", state: { ...previous.state, dirty: new Set<string>() } }
              : previous,
          );
          showFlash("sent");
          return;
        }
        if (activeBridge.mode === "demo") {
          // Demo mode has no app to close the panel; re-enable and surface it.
          setBusy(null);
          setDemoSubmitted(true);
          return;
        }
        // Prompt-mode submit and any cancel: the app owns closing the panel,
        // so the controls stay disabled.
      })
      .catch((error: unknown) => {
        setBusy(null);
        setActionError(error instanceof Error ? error.message : "The request failed.");
      });
  };

  return (
    <MantineProvider theme={panelTheme} defaultColorScheme="dark">
      {phase.kind === "loading" ? (
        <div className="panel-center">
          <Text c="dimmed" size="sm">
            Loading panel…
          </Text>
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <div className="panel-center">
          <div className="panel-error" role="alert">
            <Text fw={600} size="sm">
              Unable to load panel
            </Text>
            <Text c="dimmed" size="sm">
              {phase.message}
            </Text>
          </div>
        </div>
      ) : null}
      {phase.kind === "ready" ? (
        <div className="panel-root" data-panel-id={meta.panelId || undefined} data-panel-mode={meta.mode}>
          <header className="panel-header">
            <Text component="h1" className="panel-title" truncate>
              {phase.state.title}
            </Text>
            {flash?.kind === "updated" ? (
              <span key={flash.nonce} className="panel-flash panel-flash-updated" role="status">
                Updated by agent
              </span>
            ) : null}
            {activeBridge.mode === "demo" ? <span className="panel-demo-badge">demo</span> : null}
          </header>
          <main className="panel-body">
            {phase.state.spec.body.map((block, index) => {
              if (block.type === "markdown") {
                return <MarkdownView key={`block-${index}`} text={block.text} />;
              }
              if (block.type === "tree") {
                return (
                  <TreeBlockView
                    key={block.id}
                    block={block}
                    nodes={phase.state.trees[block.id] ?? []}
                    onNodesChange={(nodes) => updateTree(block.id, nodes)}
                  />
                );
              }
              if (block.type === "section") {
                return (
                  <SectionBlockView
                    key={block.id}
                    block={block}
                    state={phase.state.sections[block.id] ?? initialSectionState(block)}
                    onStateChange={(next) => updateSection(block.id, next)}
                  />
                );
              }
              return (
                <Text key={`block-${index}`} c="dimmed" size="xs" fs="italic">
                  [unsupported block: {block.originalType}]
                </Text>
              );
            })}
          </main>
          <footer className="panel-footer">
            {actionError ? (
              <Text c="red.4" size="xs" className="panel-footer-error" role="alert">
                {actionError}
              </Text>
            ) : null}
            {demoSubmitted && !actionError ? (
              <Text c="dimmed" size="xs" className="panel-footer-error">
                demo: payload logged to console
              </Text>
            ) : null}
            {flash?.kind === "sent" ? (
              <span key={flash.nonce} className="panel-flash panel-flash-sent" role="status">
                Sent
              </span>
            ) : null}
            <div className="panel-footer-actions">
              <Button variant="default" size="xs" disabled={busy !== null} onClick={() => runAction("cancel")}>
                {meta.mode === "live" ? "Close" : "Cancel"}
              </Button>
              <Button size="xs" loading={busy === "submit"} disabled={busy !== null} onClick={() => runAction("submit")}>
                Submit
              </Button>
            </div>
          </footer>
        </div>
      ) : null}
    </MantineProvider>
  );
}

function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (set.has(id)) {
    return set;
  }
  const next = new Set(set);
  next.add(id);
  return next;
}

function freshPanelState(title: string, spec: SanitizedSpec): PanelState {
  const trees: Record<string, TreeNode[]> = {};
  const sections: Record<string, SectionUiState> = {};
  for (const block of spec.body) {
    if (block.type === "tree") {
      trees[block.id] = block.nodes;
    } else if (block.type === "section") {
      sections[block.id] = initialSectionState(block);
    }
  }
  return { title, spec, trees, sections, dirty: new Set<string>() };
}

/**
 * Reconciles an app-pushed spec against current user state: blocks whose id
 * AND type match the previous spec keep the user's uncommitted local edits,
 * removed blocks drop their state, new blocks mount fresh from the spec.
 * Untouched (non-dirty) blocks adopt the new spec's values.
 */
function reconcilePanelState(previous: PanelState, payloadTitle: string | undefined, spec: SanitizedSpec): PanelState {
  const previousTypes = new Map<string, "tree" | "section">();
  for (const block of previous.spec.body) {
    if (block.type === "tree" || block.type === "section") {
      previousTypes.set(block.id, block.type);
    }
  }
  const trees: Record<string, TreeNode[]> = {};
  const sections: Record<string, SectionUiState> = {};
  const dirty = new Set<string>();
  for (const block of spec.body) {
    if (block.type === "tree") {
      const keep = previousTypes.get(block.id) === "tree" && previous.dirty.has(block.id);
      trees[block.id] = keep ? (previous.trees[block.id] ?? block.nodes) : block.nodes;
      if (keep) {
        dirty.add(block.id);
      }
    } else if (block.type === "section") {
      const keep = previousTypes.get(block.id) === "section" && previous.dirty.has(block.id);
      sections[block.id] = keep
        ? (previous.sections[block.id] ?? initialSectionState(block))
        : initialSectionState(block);
      if (keep) {
        dirty.add(block.id);
      }
    }
  }
  return {
    title: spec.title || payloadTitle || previous.title,
    spec,
    trees,
    sections,
    dirty,
  };
}

function parseApplyPayload(raw: unknown): ApplyPayload | null {
  if (!isRecord(raw)) {
    return null;
  }
  let spec: SanitizedSpec;
  try {
    spec = sanitizeSpec(raw.spec);
  } catch {
    return null;
  }
  const payload: ApplyPayload = { spec };
  if (typeof raw.title === "string" && raw.title.length > 0) {
    payload.title = raw.title;
  }
  return payload;
}

/** Contract shape: `{ [blockId]: result }` — trees as `{ nodes }`, sections as `{ status, comment? }`. */
function collectSubmitValue(phase: Phase): SubmitValue {
  const value: SubmitValue = {};
  if (phase.kind !== "ready") {
    return value;
  }
  for (const block of phase.state.spec.body) {
    if (block.type === "tree") {
      value[block.id] = { nodes: phase.state.trees[block.id] ?? [] };
    } else if (block.type === "section") {
      const state = phase.state.sections[block.id] ?? initialSectionState(block);
      const result: SectionResult = { status: state.status };
      const comment = state.comment.trim();
      if (comment.length > 0) {
        result.comment = comment;
      }
      value[block.id] = result;
    }
  }
  return value;
}
