import type { PanelInitValue } from "./spec";

// Hardcoded fixture used when the page is opened in a normal browser
// (no window.webkit). Exercises every spec feature: markdown rendering,
// full-featured tree editing, feature gating, notes, and excluded nodes.

export const demoInitValue: PanelInitValue = {
  title: "Review proposed changes (demo)",
  spec: {
    title: "Apply refactor to src/?",
    body: [
      {
        type: "markdown",
        text: [
          "## Refactor summary",
          "",
          "The agent wants to **restructure** the _tree module_ and rename `utils.ts`.",
          "Full plan: [design doc](https://example.com/plan).",
          "",
          "```ts",
          "export function moveNode(nodes: TreeNode[], source: string, target: string) {}",
          "```",
          "",
          "- drag rows onto folders to move them",
          "- double-click a label to rename",
          "- uncheck anything you want left alone",
          "",
          "1. review the tree below",
          "2. press Submit",
          "",
          "---",
        ].join("\n"),
      },
      {
        type: "tree",
        id: "files",
        nodes: [
          {
            id: "src",
            label: "src",
            children: [
              {
                id: "src/tree",
                label: "tree",
                note: "new",
                children: [
                  { id: "src/tree/state.ts", label: "state.ts", note: "new" },
                  { id: "src/tree/render.ts", label: "render.ts", note: "renamed from view.ts" },
                ],
              },
              { id: "src/helpers.ts", label: "helpers.ts", note: "renamed from utils.ts" },
              { id: "src/legacy.ts", label: "legacy.ts", included: false, note: "deleted" },
              { id: "src/empty", label: "empty", children: [] },
            ],
          },
          {
            id: "test",
            label: "test",
            children: [{ id: "test/tree.test.ts", label: "tree.test.ts", note: "new" }],
          },
          { id: "README.md", label: "README.md" },
        ],
      },
      {
        type: "markdown",
        text: "The tree below is **toggle-only** (no rename, no move):",
      },
      {
        type: "tree",
        id: "options",
        features: ["toggle"],
        nodes: [
          { id: "opt/changelog", label: "update CHANGELOG.md" },
          { id: "opt/tests", label: "run full test suite", included: false },
        ],
      },
    ],
  },
};
