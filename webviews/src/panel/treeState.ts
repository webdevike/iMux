import type { TreeNode } from "./spec";

// Pure transforms over the edited TreeNode arrays. Every function returns new
// arrays along the mutated path and shares untouched subtrees, so React state
// updates stay cheap and the submit payload is always the current arrays.

export function findNode(nodes: readonly TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    if (node.children) {
      const hit = findNode(node.children, id);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

/** True when `id` lives strictly inside the subtree rooted at `ancestorId`. */
export function isDescendantOf(nodes: readonly TreeNode[], ancestorId: string, id: string): boolean {
  const ancestor = findNode(nodes, ancestorId);
  if (!ancestor?.children) {
    return false;
  }
  return findNode(ancestor.children, id) !== null;
}

function updateNode(
  nodes: readonly TreeNode[],
  id: string,
  update: (node: TreeNode) => TreeNode,
): { nodes: TreeNode[]; changed: boolean } {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.id === id) {
      changed = true;
      return update(node);
    }
    if (node.children && !changed) {
      const child = updateNode(node.children, id, update);
      if (child.changed) {
        changed = true;
        return { ...node, children: child.nodes };
      }
    }
    return node;
  });
  return changed ? { nodes: next, changed } : { nodes: nodes as TreeNode[], changed };
}

/** Renames a node. Whitespace-only labels are rejected (returns input array). */
export function renameNode(nodes: readonly TreeNode[], id: string, label: string): TreeNode[] {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return nodes as TreeNode[];
  }
  return updateNode(nodes, id, (node) => (node.label === trimmed ? node : { ...node, label: trimmed })).nodes;
}

/** Sets the `included` flag on one node only; descendants are left untouched. */
export function setIncluded(nodes: readonly TreeNode[], id: string, included: boolean): TreeNode[] {
  return updateNode(nodes, id, (node) => ({ ...node, included })).nodes;
}

/**
 * True when `sourceId` may be reparented onto `targetId`: the target must be
 * an existing folder, not the source itself, and not inside the source's own
 * subtree (a cycle would orphan the branch).
 */
export function canDropInto(nodes: readonly TreeNode[], sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) {
    return false;
  }
  const target = findNode(nodes, targetId);
  if (!target || !Array.isArray(target.children)) {
    return false;
  }
  if (!findNode(nodes, sourceId)) {
    return false;
  }
  return !isDescendantOf(nodes, sourceId, targetId);
}

function removeNode(
  nodes: readonly TreeNode[],
  id: string,
): { nodes: TreeNode[]; removed: TreeNode | null } {
  let removed: TreeNode | null = null;
  const next: TreeNode[] = [];
  for (const node of nodes) {
    if (node.id === id) {
      removed = node;
      continue;
    }
    if (node.children && !removed) {
      const child = removeNode(node.children, id);
      if (child.removed) {
        removed = child.removed;
        next.push({ ...node, children: child.nodes });
        continue;
      }
    }
    next.push(node);
  }
  return removed ? { nodes: next, removed } : { nodes: nodes as TreeNode[], removed: null };
}

/**
 * Reparents `sourceId` by appending it to `targetId`'s children.
 * Returns null when the drop is invalid (see canDropInto).
 */
export function moveNode(nodes: readonly TreeNode[], sourceId: string, targetId: string): TreeNode[] | null {
  if (!canDropInto(nodes, sourceId, targetId)) {
    return null;
  }
  const { nodes: without, removed } = removeNode(nodes, sourceId);
  if (!removed) {
    return null;
  }
  const inserted = updateNode(without, targetId, (target) => ({
    ...target,
    children: [...(target.children ?? []), removed],
  }));
  return inserted.changed ? inserted.nodes : null;
}

export type FlatRow = {
  node: TreeNode;
  depth: number;
  folder: boolean;
  /** True when any ancestor carries included === false. */
  ancestorExcluded: boolean;
};

/** Depth-first visible rows; children of collapsed folders are skipped. */
export function flattenTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (level: readonly TreeNode[], depth: number, ancestorExcluded: boolean) => {
    for (const node of level) {
      const folder = Array.isArray(node.children);
      rows.push({ node, depth, folder, ancestorExcluded });
      if (folder && !collapsed.has(node.id)) {
        walk(node.children ?? [], depth + 1, ancestorExcluded || node.included === false);
      }
    }
  };
  walk(nodes, 0, false);
  return rows;
}
