import { Checkbox, TextInput } from "@mantine/core";
import React, { useRef, useState } from "react";
import { treeFeatureEnabled, type TreeBlock, type TreeNode } from "./spec";
import { canDropInto, flattenTree, moveNode, renameNode, setIncluded, type FlatRow } from "./treeState";

type TreeBlockViewProps = {
  block: TreeBlock;
  nodes: TreeNode[];
  onNodesChange: (nodes: TreeNode[]) => void;
};

export function TreeBlockView({ block, nodes, onNodesChange }: TreeBlockViewProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // The dragged node id lives in a ref: dataTransfer payloads are unreadable
  // during dragover in WebKit, and re-rendering on dragstart is pointless.
  const dragIdRef = useRef<string | null>(null);

  const renameEnabled = treeFeatureEnabled(block, "rename");
  const moveEnabled = treeFeatureEnabled(block, "move");
  const toggleEnabled = treeFeatureEnabled(block, "toggle");

  const clearDrag = () => {
    dragIdRef.current = null;
    setDropTargetId(null);
  };

  const toggleCollapsed = (id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  };

  const commitRename = (id: string, label: string) => {
    setEditingId(null);
    onNodesChange(renameNode(nodes, id, label));
  };

  const handleDrop = (targetId: string) => {
    const dragId = dragIdRef.current;
    if (dragId) {
      const next = moveNode(nodes, dragId, targetId);
      if (next) {
        onNodesChange(next);
        setCollapsed((previous) => {
          if (!previous.has(targetId)) {
            return previous;
          }
          const expanded = new Set(previous);
          expanded.delete(targetId);
          return expanded;
        });
      }
    }
    clearDrag();
  };

  const renderRow = (row: FlatRow) => {
    const { node, depth, folder, ancestorExcluded } = row;
    const excluded = node.included === false;
    const editing = editingId === node.id;
    const classes = ["panel-tree-row"];
    if (excluded) {
      classes.push("is-excluded");
    }
    if (ancestorExcluded) {
      classes.push("is-ancestor-excluded");
    }
    if (dropTargetId === node.id) {
      classes.push("is-drop-target");
    }

    return (
      <div
        key={node.id}
        className={classes.join(" ")}
        style={{ paddingLeft: depth * 18 + 6 }}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={folder ? !collapsed.has(node.id) : undefined}
        data-node-id={node.id}
        draggable={moveEnabled && !editing}
        onDragStart={(event) => {
          dragIdRef.current = node.id;
          event.dataTransfer.effectAllowed = "move";
          // WebKit refuses to start a drag without payload data.
          event.dataTransfer.setData("text/plain", node.id);
        }}
        onDragEnd={clearDrag}
        onDragOver={(event) => {
          const dragId = dragIdRef.current;
          if (dragId && folder && canDropInto(nodes, dragId, node.id)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (dropTargetId !== node.id) {
              setDropTargetId(node.id);
            }
          } else if (dropTargetId === node.id) {
            setDropTargetId(null);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          handleDrop(node.id);
        }}
      >
        {folder ? (
          <button
            type="button"
            className="panel-tree-chevron"
            aria-label={collapsed.has(node.id) ? "Expand" : "Collapse"}
            onClick={() => toggleCollapsed(node.id)}
          >
            <svg viewBox="0 0 16 16" className={collapsed.has(node.id) ? "" : "is-open"} aria-hidden="true">
              <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        ) : (
          <span className="panel-tree-chevron" aria-hidden="true" />
        )}
        {toggleEnabled ? (
          <Checkbox
            size="xs"
            checked={node.included !== false}
            onChange={(event) => onNodesChange(setIncluded(nodes, node.id, event.currentTarget.checked))}
            aria-label={`Include ${node.label}`}
          />
        ) : null}
        {editing ? (
          <RenameInput
            initial={node.label}
            onCommit={(label) => commitRename(node.id, label)}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <span
            className="panel-tree-label"
            onDoubleClick={renameEnabled ? () => setEditingId(node.id) : undefined}
            title={renameEnabled ? "Double-click to rename" : undefined}
          >
            {node.label}
            {folder ? <span className="panel-tree-slash">/</span> : null}
          </span>
        )}
        {node.note ? <span className="panel-tree-note">{node.note}</span> : null}
      </div>
    );
  };

  return (
    <div className="panel-tree" role="tree" aria-label={block.id}>
      {flattenTree(nodes, collapsed).map(renderRow)}
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (label: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  // Enter, Escape, and blur race (committing unmounts the input, which then
  // blurs); whichever settles first wins and the rest become no-ops.
  const settledRef = useRef(false);

  const settle = (action: () => void) => {
    if (!settledRef.current) {
      settledRef.current = true;
      action();
    }
  };

  return (
    <TextInput
      className="panel-tree-rename"
      size="xs"
      autoFocus
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={(event) => {
        // Commit from the DOM value, not the onChange-tracked state: it is
        // authoritative at commit time regardless of change-event timing.
        const domValue = event.currentTarget.value;
        if (event.key === "Enter") {
          settle(() => onCommit(domValue));
        } else if (event.key === "Escape") {
          settle(onCancel);
        }
      }}
      onBlur={(event) => {
        const domValue = event.currentTarget.value;
        settle(() => onCommit(domValue));
      }}
      onFocus={(event) => event.currentTarget.select()}
    />
  );
}
