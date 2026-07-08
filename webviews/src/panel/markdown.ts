// Minimal hand-rolled markdown parser for panel "markdown" blocks.
// Deliberately tiny: headings, paragraphs, fenced code, flat lists,
// horizontal rules, and inline code/bold/italic/links. The output is a plain
// token tree rendered through React text nodes, so spec-provided text can
// never inject markup or run code.

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; children: MdInline[]; href: string };

export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { kind: "para"; children: MdInline[] }
  | { kind: "code"; text: string; lang: string }
  | { kind: "list"; ordered: boolean; items: MdInline[][] }
  | { kind: "hr" };

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const FENCE_OPEN_PATTERN = /^```([\w+-]*)\s*$/;
const HR_PATTERN = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UNORDERED_ITEM_PATTERN = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "para", children: parseInline(paragraph.join(" ")) });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = line.match(FENCE_OPEN_PATTERN);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[1] ?? "" });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2]),
      });
      continue;
    }

    if (HR_PATTERN.test(line)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      continue;
    }

    const unordered = line.match(UNORDERED_ITEM_PATTERN);
    const ordered = unordered ? null : line.match(ORDERED_ITEM_PATTERN);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const items: MdInline[][] = [parseInline((unordered ?? ordered)![1])];
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(isOrdered ? ORDERED_ITEM_PATTERN : UNORDERED_ITEM_PATTERN);
        if (!next) {
          break;
        }
        items.push(parseInline(next[1]));
        index += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}

type InlineMatch = {
  start: number;
  end: number;
  token: MdInline;
};

const INLINE_CODE_PATTERN = /`([^`\n]+)`/;
const STRONG_PATTERN = /\*\*([^*]+(?:\*[^*]+)*)\*\*/;
const EM_STAR_PATTERN = /\*([^*\n]+)\*/;
const EM_UNDERSCORE_PATTERN = /(?<![\w])_([^_\n]+)_(?![\w])/;
const LINK_PATTERN = /\[([^\]\n]*)\]\(([^)\s]*)\)/;

export function parseInline(text: string): MdInline[] {
  const tokens: MdInline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = earliestInlineMatch(rest);
    if (!match) {
      tokens.push({ kind: "text", text: rest });
      break;
    }
    if (match.start > 0) {
      tokens.push({ kind: "text", text: rest.slice(0, match.start) });
    }
    tokens.push(match.token);
    rest = rest.slice(match.end);
  }
  return tokens;
}

function earliestInlineMatch(text: string): InlineMatch | null {
  let best: InlineMatch | null = null;
  const consider = (candidate: InlineMatch | null) => {
    if (candidate && (!best || candidate.start < best.start)) {
      best = candidate;
    }
  };

  const code = text.match(INLINE_CODE_PATTERN);
  if (code?.index !== undefined) {
    consider({
      start: code.index,
      end: code.index + code[0].length,
      token: { kind: "code", text: code[1] },
    });
  }
  const link = text.match(LINK_PATTERN);
  if (link?.index !== undefined) {
    consider({
      start: link.index,
      end: link.index + link[0].length,
      token: { kind: "link", children: parseInline(link[1]), href: link[2] },
    });
  }
  const strong = text.match(STRONG_PATTERN);
  if (strong?.index !== undefined) {
    consider({
      start: strong.index,
      end: strong.index + strong[0].length,
      token: { kind: "strong", children: parseInline(strong[1]) },
    });
  }
  for (const pattern of [EM_STAR_PATTERN, EM_UNDERSCORE_PATTERN]) {
    const em = text.match(pattern);
    if (em?.index !== undefined) {
      consider({
        start: em.index,
        end: em.index + em[0].length,
        token: { kind: "em", children: parseInline(em[1]) },
      });
    }
  }
  return best;
}
