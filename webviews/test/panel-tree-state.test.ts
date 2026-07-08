import { describe, expect, test } from "bun:test";
import type { TreeNode } from "../src/panel/spec";
import {
  canDropInto,
  findNode,
  flattenTree,
  isDescendantOf,
  moveNode,
  renameNode,
  setIncluded,
} from "../src/panel/treeState";

function fixture(): TreeNode[] {
  return [
    {
      id: "src",
      label: "src",
      children: [
        {
          id: "src/tree",
          label: "tree",
          children: [{ id: "src/tree/state.ts", label: "state.ts" }],
        },
        { id: "src/helpers.ts", label: "helpers.ts" },
      ],
    },
    { id: "empty", label: "empty", children: [] },
    { id: "README.md", label: "README.md", included: false },
  ];
}

describe("findNode / isDescendantOf", () => {
  test("finds nested nodes and resolves ancestry", () => {
    const nodes = fixture();
    expect(findNode(nodes, "src/tree/state.ts")?.label).toBe("state.ts");
    expect(findNode(nodes, "missing")).toBeNull();
    expect(isDescendantOf(nodes, "src", "src/tree/state.ts")).toBe(true);
    expect(isDescendantOf(nodes, "src/tree", "src/helpers.ts")).toBe(false);
    expect(isDescendantOf(nodes, "README.md", "src")).toBe(false);
  });
});

describe("renameNode", () => {
  test("renames along the path and shares untouched subtrees", () => {
    const nodes = fixture();
    const next = renameNode(nodes, "src/helpers.ts", "util.ts");
    expect(findNode(next, "src/helpers.ts")?.label).toBe("util.ts");
    expect(findNode(nodes, "src/helpers.ts")?.label).toBe("helpers.ts");
    expect(next[1]).toBe(nodes[1]);
    expect(next[2]).toBe(nodes[2]);
  });

  test("trims and rejects whitespace-only labels", () => {
    const nodes = fixture();
    expect(findNode(renameNode(nodes, "src/helpers.ts", "  padded.ts "), "src/helpers.ts")?.label).toBe("padded.ts");
    expect(renameNode(nodes, "src/helpers.ts", "   ")).toBe(nodes);
  });
});

describe("setIncluded", () => {
  test("flips one node only; descendants keep their own flags", () => {
    const nodes = fixture();
    const next = setIncluded(nodes, "src", false);
    expect(findNode(next, "src")?.included).toBe(false);
    expect(findNode(next, "src/helpers.ts")?.included).toBeUndefined();
    expect(findNode(setIncluded(nodes, "README.md", true), "README.md")?.included).toBe(true);
  });
});

describe("canDropInto / moveNode", () => {
  test("moves a node by appending to the target folder", () => {
    const nodes = fixture();
    const next = moveNode(nodes, "src/helpers.ts", "src/tree");
    expect(next).not.toBeNull();
    const treeFolder = findNode(next!, "src/tree");
    expect(treeFolder?.children?.map((node) => node.id)).toEqual(["src/tree/state.ts", "src/helpers.ts"]);
    // Source is removed from its previous parent.
    expect(findNode(next!, "src")?.children?.map((node) => node.id)).toEqual(["src/tree"]);
  });

  test("moves folders into empty folders", () => {
    const next = moveNode(fixture(), "src/tree", "empty");
    expect(findNode(next!, "empty")?.children?.map((node) => node.id)).toEqual(["src/tree"]);
    expect(findNode(next!, "src/tree/state.ts")?.label).toBe("state.ts");
  });

  test("guards dropping a node into its own descendant", () => {
    const nodes = fixture();
    expect(canDropInto(nodes, "src", "src/tree")).toBe(false);
    expect(moveNode(nodes, "src", "src/tree")).toBeNull();
  });

  test("guards self-drops, file targets, and unknown ids", () => {
    const nodes = fixture();
    expect(canDropInto(nodes, "src", "src")).toBe(false);
    expect(canDropInto(nodes, "src/tree", "README.md")).toBe(false);
    expect(canDropInto(nodes, "ghost", "src")).toBe(false);
    expect(canDropInto(nodes, "src/tree", "ghost")).toBe(false);
    expect(moveNode(nodes, "src/tree", "README.md")).toBeNull();
  });

  test("re-dropping into the current parent appends to the end", () => {
    const next = moveNode(fixture(), "src/tree", "src");
    expect(findNode(next!, "src")?.children?.map((node) => node.id)).toEqual(["src/helpers.ts", "src/tree"]);
  });
});

describe("flattenTree", () => {
  test("walks depth-first with depth, folder flag, and ancestor exclusion", () => {
    const nodes = setIncluded(fixture(), "src", false);
    const rows = flattenTree(nodes, new Set());
    expect(rows.map((row) => [row.node.id, row.depth, row.folder, row.ancestorExcluded])).toEqual([
      ["src", 0, true, false],
      ["src/tree", 1, true, true],
      ["src/tree/state.ts", 2, false, true],
      ["src/helpers.ts", 1, false, true],
      ["empty", 0, true, false],
      ["README.md", 0, false, false],
    ]);
  });

  test("skips children of collapsed folders", () => {
    const rows = flattenTree(fixture(), new Set(["src/tree"]));
    expect(rows.map((row) => row.node.id)).toEqual(["src", "src/tree", "src/helpers.ts", "empty", "README.md"]);
  });
});
