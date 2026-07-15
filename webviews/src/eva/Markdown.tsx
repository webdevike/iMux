import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Anchor, Code } from "@mantine/core";
import { CodeHighlight } from "@mantine/code-highlight";

// No raw-HTML passthrough plugin and no HTML-injection prop -> embedded raw
// HTML renders as inert text (T-1-04 / T-2-01 mitigation; negative-grep gated).
const components: Components = {
  // Strip the <pre> wrapper so CodeHighlight owns the whole fenced block.
  pre: ({ children }) => <>{children}</>,
  code({ className, children }) {
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    if (!lang) {
      return <Code>{children}</Code>; // inline code
    }
    return (
      <CodeHighlight
        code={String(children).replace(/\n$/, "")}
        language={lang}
      />
    );
  },
  a: ({ href, children }) => (
    <Anchor
      href={href}
      onClick={(e) => {
        e.preventDefault();
        // Only web / mail schemes are opened; any other scheme (javascript:,
        // file:, custom:) is rendered but never opened (T-2-03). Runs in a
        // WKWebview panel, so a plain window.open hands the URL to the host.
        if (href && /^(https?:|mailto:)/i.test(href.trim())) {
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
    >
      {children}
    </Anchor>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
