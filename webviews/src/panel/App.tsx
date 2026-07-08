import { Button, MantineProvider, Text, createTheme } from "@mantine/core";
import React, { useEffect, useMemo, useState } from "react";
import { MarkdownView } from "./MarkdownView";
import { TreeBlockView } from "./TreeBlockView";
import { detectBridge, type PanelBridge } from "./bridge";
import { demoInitValue } from "./demoSpec";
import { sanitizeSpec, type SanitizedSpec, type SubmitValue, type TreeNode } from "./spec";

const panelTheme = createTheme({
  fontFamily: "var(--panel-font-sans)",
  fontFamilyMonospace: "var(--panel-font-mono)",
  defaultRadius: "sm",
  cursorType: "pointer",
  scale: 0.95,
});

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; title: string; spec: SanitizedSpec };

type PanelAppProps = {
  /** Injectable for tests; defaults to native-vs-demo detection. */
  bridge?: PanelBridge;
};

export function PanelApp({ bridge }: PanelAppProps) {
  const activeBridge = useMemo(() => bridge ?? detectBridge(window, demoInitValue), [bridge]);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [trees, setTrees] = useState<Record<string, TreeNode[]>>({});
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [demoSubmitted, setDemoSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    activeBridge
      .init()
      .then((initValue) => {
        if (cancelled) {
          return;
        }
        const spec = sanitizeSpec(initValue.spec);
        const title = spec.title || initValue.title || "Panel";
        const initialTrees: Record<string, TreeNode[]> = {};
        for (const block of spec.body) {
          if (block.type === "tree") {
            initialTrees[block.id] = block.nodes;
          }
        }
        document.title = initValue.title || title;
        setTrees(initialTrees);
        setPhase({ kind: "ready", title, spec });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPhase({ kind: "error", message: error instanceof Error ? error.message : "The panel failed to load." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeBridge]);

  const runAction = (action: "submit" | "cancel") => {
    setBusy(action);
    setActionError(null);
    const call =
      action === "submit"
        ? activeBridge.submit(collectSubmitValue(phase, trees))
        : activeBridge.cancel();
    call
      .then(() => {
        // The app owns closing the panel. In demo mode nothing closes, so
        // re-enable the controls and surface what happened.
        if (activeBridge.mode === "demo") {
          setBusy(null);
          setDemoSubmitted(true);
        }
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
        <div className="panel-root">
          <header className="panel-header">
            <Text component="h1" className="panel-title" truncate>
              {phase.title}
            </Text>
            {activeBridge.mode === "demo" ? <span className="panel-demo-badge">demo</span> : null}
          </header>
          <main className="panel-body">
            {phase.spec.body.map((block, index) => {
              if (block.type === "markdown") {
                return <MarkdownView key={`block-${index}`} text={block.text} />;
              }
              if (block.type === "tree") {
                return (
                  <TreeBlockView
                    key={block.id}
                    block={block}
                    nodes={trees[block.id] ?? []}
                    onNodesChange={(nodes) => setTrees((previous) => ({ ...previous, [block.id]: nodes }))}
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
            <div className="panel-footer-actions">
              <Button variant="default" size="xs" disabled={busy !== null} onClick={() => runAction("cancel")}>
                Cancel
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

/** Contract shape: `{ [treeBlockId]: { nodes } }` for every tree block. */
function collectSubmitValue(phase: Phase, trees: Record<string, TreeNode[]>): SubmitValue {
  const value: SubmitValue = {};
  if (phase.kind === "ready") {
    for (const block of phase.spec.body) {
      if (block.type === "tree") {
        value[block.id] = { nodes: trees[block.id] ?? [] };
      }
    }
  }
  return value;
}
