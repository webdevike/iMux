import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../src/panel/markdown";

describe("parseMarkdown blocks", () => {
  test("headings, paragraphs, and rules", () => {
    const blocks = parseMarkdown("## Title\n\nfirst line\nsecond line\n\n---");
    expect(blocks).toEqual([
      { kind: "heading", level: 2, children: [{ kind: "text", text: "Title" }] },
      { kind: "para", children: [{ kind: "text", text: "first line second line" }] },
      { kind: "hr" },
    ]);
  });

  test("fenced code keeps raw text verbatim, including markup", () => {
    const blocks = parseMarkdown('```ts\nconst a = "<script>alert(1)</script>";\n**not bold**\n```');
    expect(blocks).toEqual([
      { kind: "code", lang: "ts", text: 'const a = "<script>alert(1)</script>";\n**not bold**' },
    ]);
  });

  test("unclosed fence swallows the rest of the input", () => {
    expect(parseMarkdown("```\na\nb")).toEqual([{ kind: "code", lang: "", text: "a\nb" }]);
  });

  test("unordered and ordered lists group consecutive items", () => {
    const blocks = parseMarkdown("- one\n- two\n\n1. first\n2. second");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
      },
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", text: "first" }], [{ kind: "text", text: "second" }]],
      },
    ]);
  });
});

describe("parseInline", () => {
  test("code, strong, em, and links", () => {
    expect(parseInline("run `bun test` **now** with *care* via [docs](https://x.dev)")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "bun test" },
      { kind: "text", text: " " },
      { kind: "strong", children: [{ kind: "text", text: "now" }] },
      { kind: "text", text: " with " },
      { kind: "em", children: [{ kind: "text", text: "care" }] },
      { kind: "text", text: " via " },
      { kind: "link", children: [{ kind: "text", text: "docs" }], href: "https://x.dev" },
    ]);
  });

  test("strong beats em at the same position", () => {
    expect(parseInline("**bold**")).toEqual([{ kind: "strong", children: [{ kind: "text", text: "bold" }] }]);
  });

  test("nested emphasis inside strong", () => {
    expect(parseInline("**a *b* c**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "a " },
          { kind: "em", children: [{ kind: "text", text: "b" }] },
          { kind: "text", text: " c" },
        ],
      },
    ]);
  });

  test("snake_case identifiers are not italicized", () => {
    expect(parseInline("use snake_case_name here")).toEqual([{ kind: "text", text: "use snake_case_name here" }]);
  });

  test("backticks suppress emphasis inside code spans", () => {
    expect(parseInline("`**raw**`")).toEqual([{ kind: "code", text: "**raw**" }]);
  });
});
