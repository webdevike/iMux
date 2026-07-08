import React from "react";
import { parseMarkdown, type MdBlock, type MdInline } from "./markdown";

// Renders the parsed markdown token tree through React text nodes only —
// never innerHTML — so spec-provided text cannot inject markup. Links are
// deliberate no-ops: the panel is sandboxed and navigation would replace it.

function renderInline(tokens: MdInline[], keyPrefix: string): React.ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (token.kind) {
      case "text":
        return token.text;
      case "code":
        return (
          <code key={key} className="panel-md-code">
            {token.text}
          </code>
        );
      case "strong":
        return <strong key={key}>{renderInline(token.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(token.children, key)}</em>;
      case "link":
        return (
          <a
            key={key}
            className="panel-md-link"
            title={token.href}
            onClick={(event) => event.preventDefault()}
          >
            {renderInline(token.children, key)}
          </a>
        );
    }
  });
}

function renderBlock(block: MdBlock, index: number): React.ReactNode {
  const key = `b${index}`;
  switch (block.kind) {
    case "heading": {
      const Heading = `h${block.level}` as "h1";
      return <Heading key={key}>{renderInline(block.children, key)}</Heading>;
    }
    case "para":
      return <p key={key}>{renderInline(block.children, key)}</p>;
    case "code":
      return (
        <pre key={key} className="panel-md-pre" data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li key={`${key}.${itemIndex}`}>{renderInline(item, `${key}.${itemIndex}`)}</li>
      ));
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "hr":
      return <hr key={key} />;
  }
}

export function MarkdownView({ text }: { text: string }) {
  return <div className="panel-markdown">{parseMarkdown(text).map(renderBlock)}</div>;
}
