import type { ReactNode } from "react";
import { Box, Code, Collapse, Group, Loader, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";

/**
 * A tool-activity transcript item — the same structural shape the transcript
 * model (plan 02-07) builds from ToolStart/ToolEnd, so its tool items pass
 * straight through to <ToolRow>. `title` is the D-01 verb+target one-liner
 * already derived in the omp client; `output` is already tail-truncated there
 * (D-04). Both render as React text children here — never JSON-stringified.
 */
export type ToolItem = {
  id: string;
  name: string;
  title: string;
  status: "running" | "ok" | "error";
  output?: string;
};

// Subtle terminal-native glyphs by tool (D-01) — kept monochrome/dim so a run of
// rows reads like a cmux activity log, not a chrome-y toolbar. Falls back to a
// neutral bullet for tools without a dedicated glyph.
const TOOL_GLYPH: Record<string, string> = {
  bash: "$",
  read: "≡",
  write: "✎",
  edit: "✎",
  grep: "⌕",
  glob: "⌕",
};

function glyphFor(item: ToolItem): string {
  if (item.status === "error") return "✕";
  return TOOL_GLYPH[item.name] ?? "•";
}

/**
 * Compact one-line tool row: a leading status/tool indicator plus the pre-derived
 * title, click-to-expand collapsed monospace output. Running -> Mantine spinner;
 * ok -> a static tool glyph; error -> an error glyph and the whole row tinted with
 * the theme error color, still fully clickable/expandable (D-03). Presentational
 * only: props in, dark row out.
 */
export function ToolRow({ item }: { item: ToolItem }) {
  const [opened, { toggle }] = useDisclosure(false);
  const failed = item.status === "error";
  // Theme error color drives both the glyph/title tint and a faint row wash so a
  // failed row reads as failed at a glance without a per-tool bubble.
  const errorColor = "var(--mantine-color-error)";

  return (
    <Box
      style={{
        color: failed ? errorColor : undefined,
        backgroundColor: failed
          ? `color-mix(in srgb, ${errorColor} 12%, transparent)`
          : undefined,
        borderRadius: 4,
      }}
    >
      <UnstyledButton
        onClick={toggle}
        aria-expanded={opened}
        style={{ display: "block", width: "100%", padding: "2px 6px" }}
      >
        <Group gap={8} wrap="nowrap">
          <Box
            style={{
              flex: "0 0 14px",
              width: 14,
              height: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--mantine-font-family-monospace)",
              fontSize: "var(--mantine-font-size-sm)",
              color: failed ? errorColor : "var(--mantine-color-dimmed)",
            }}
          >
            {item.status === "running" ? (
              <Loader size={12} color="gray" />
            ) : (
              glyphFor(item)
            )}
          </Box>
          <Text
            span
            truncate
            size="sm"
            ff="monospace"
            c={failed ? errorColor : "gray.4"}
            style={{ flex: 1, minWidth: 0 }}
          >
            {item.title}
          </Text>
          <Text
            span
            size="xs"
            c="dimmed"
            style={{
              flex: "0 0 auto",
              transform: opened ? "rotate(90deg)" : "none",
              transition: "transform 120ms ease",
            }}
          >
            ▸
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened}>
        <Box style={{ padding: "0 6px 6px 28px" }}>
          <Code
            block
            style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }}
          >
            {item.output && item.output.length > 0 ? item.output : "(no output)"}
          </Code>
        </Box>
      </Collapse>
    </Box>
  );
}

/**
 * Tight cluster for consecutive tool rows (D-02): one subtle bordered/indented
 * block that sits between assistant text chunks — no per-tool chat bubbles,
 * minimal chrome. The App integration (02-07) wraps a run of consecutive tool
 * items in a single <ToolGroup>.
 */
export function ToolGroup({ children }: { children: ReactNode }) {
  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        padding: 4,
        borderRadius: 6,
        border: "1px solid var(--mantine-color-dark-4)",
        backgroundColor: "var(--mantine-color-dark-6)",
      }}
    >
      {children}
    </Box>
  );
}
