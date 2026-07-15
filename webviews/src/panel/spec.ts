// Panel spec schema v1. This mirrors the frozen bridge contract shared with the
// Swift side; the spec is data only and must never carry executable code.

export type Spec = { title?: string; body: Block[] };

export type Block = MarkdownBlock | TreeBlock | SectionBlock;

export type MarkdownBlock = { type: "markdown"; text: string };

export type TreeFeature = "rename" | "move" | "toggle";

export type TreeBlock = {
  type: "tree";
  /** Result key inside the submit payload. */
  id: string;
  nodes: TreeNode[];
  /** Enabled interactions; omitted means all features are on. */
  features?: TreeFeature[];
};

export type TreeNode = {
  id: string;
  /** File/folder name. */
  label: string;
  /** Presence (even empty) marks the node as a folder. */
  children?: TreeNode[];
  /** Defaults to true; the toggle feature renders it as a checkbox. */
  included?: boolean;
  /** Dimmed annotation, e.g. "new", "renamed from x". */
  note?: string;
};

/** Reviewable plan-doc section: markdown body plus a user decision + note. */
export type SectionStatus = "none" | "proposed" | "approved" | "rejected";

export type SectionBlock = {
  type: "section";
  /** Result key inside the submit payload. */
  id: string;
  heading?: string;
  /** Body, rendered with the shared markdown renderer. */
  markdown: string;
  /** Initial status; defaults to "proposed". */
  status?: SectionStatus;
  /** Defaults to true; renders the Approve / Reject control. */
  decidable?: boolean;
  /** Defaults to true; renders the comment textarea. */
  commentable?: boolean;
};

/** How the app drives the panel: prompt closes on submit, live keeps iterating. */
export type PanelMode = "prompt" | "live";

export type PanelInitValue = { title: string; spec: Spec; mode: PanelMode; panelId: string };

export type TreeResult = { nodes: TreeNode[] };
/** Comment is omitted when empty or whitespace-only. */
export type SectionResult = { status: SectionStatus; comment?: string };

/** Submit payload keyed by block id: trees as edited nodes, sections as decisions. */
export type SubmitValue = Record<string, TreeResult | SectionResult>;

// Internal sanitized representation. Unknown block types are preserved as
// placeholders so a newer agent-side schema degrades visibly instead of
// silently dropping content.
export type SanitizedBlock = MarkdownBlock | TreeBlock | SectionBlock | UnknownBlock;
export type UnknownBlock = { type: "unknown"; originalType: string };
export type SanitizedSpec = { title?: string; body: SanitizedBlock[] };

const TREE_FEATURES: readonly TreeFeature[] = ["rename", "move", "toggle"];
const SECTION_STATUSES: readonly SectionStatus[] = ["none", "proposed", "approved", "rejected"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Defensively coerces an untrusted init payload into a renderable spec.
 * Throws when the payload is structurally unusable.
 */
export function sanitizeSpec(raw: unknown): SanitizedSpec {
  if (!isRecord(raw) || !Array.isArray(raw.body)) {
    throw new Error("Panel received an invalid spec.");
  }
  const body: SanitizedBlock[] = [];
  raw.body.forEach((rawBlock, index) => {
    const block = sanitizeBlock(rawBlock, index);
    if (block) {
      body.push(block);
    }
  });
  const spec: SanitizedSpec = { body };
  if (typeof raw.title === "string" && raw.title.length > 0) {
    spec.title = raw.title;
  }
  return spec;
}

function sanitizeBlock(raw: unknown, index: number): SanitizedBlock | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.type === "markdown") {
    return { type: "markdown", text: typeof raw.text === "string" ? raw.text : "" };
  }
  if (raw.type === "tree") {
    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `tree-${index}`;
    const block: TreeBlock = {
      type: "tree",
      id,
      nodes: sanitizeNodes(Array.isArray(raw.nodes) ? raw.nodes : [], id),
    };
    if (Array.isArray(raw.features)) {
      block.features = TREE_FEATURES.filter((feature) => (raw.features as unknown[]).includes(feature));
    }
    return block;
  }
  if (raw.type === "section") {
    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `section-${index}`;
    // Defaults are resolved here so rendering and submit collection never
    // re-derive them: status "proposed", both controls enabled.
    const block: SectionBlock = {
      type: "section",
      id,
      markdown: typeof raw.markdown === "string" ? raw.markdown : "",
      status: SECTION_STATUSES.includes(raw.status as SectionStatus) ? (raw.status as SectionStatus) : "proposed",
      decidable: raw.decidable !== false,
      commentable: raw.commentable !== false,
    };
    if (typeof raw.heading === "string" && raw.heading.length > 0) {
      block.heading = raw.heading;
    }
    return block;
  }
  return { type: "unknown", originalType: typeof raw.type === "string" ? raw.type : "?" };
}

function sanitizeNodes(raw: unknown[], pathPrefix: string): TreeNode[] {
  const nodes: TreeNode[] = [];
  raw.forEach((rawNode, index) => {
    if (!isRecord(rawNode)) {
      return;
    }
    const fallbackId = `${pathPrefix}.${index}`;
    const id = typeof rawNode.id === "string" && rawNode.id.length > 0 ? rawNode.id : fallbackId;
    const node: TreeNode = {
      id,
      label: typeof rawNode.label === "string" ? rawNode.label : id,
    };
    if (Array.isArray(rawNode.children)) {
      node.children = sanitizeNodes(rawNode.children, fallbackId);
    }
    if (typeof rawNode.included === "boolean") {
      node.included = rawNode.included;
    }
    if (typeof rawNode.note === "string" && rawNode.note.length > 0) {
      node.note = rawNode.note;
    }
    nodes.push(node);
  });
  return nodes;
}

export function treeFeatureEnabled(block: TreeBlock, feature: TreeFeature): boolean {
  return block.features ? block.features.includes(feature) : true;
}
