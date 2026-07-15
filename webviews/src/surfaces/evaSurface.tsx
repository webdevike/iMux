import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import { CodeHighlightAdapterProvider, createHighlightJsAdapter } from "@mantine/code-highlight";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import rust from "highlight.js/lib/languages/rust";
import python from "highlight.js/lib/languages/python";
import mantineCoreStyles from "@mantine/core/styles.css?inline";
import mantineCodeHighlightStyles from "@mantine/code-highlight/styles.css?inline";
import hljsThemeStyles from "highlight.js/styles/atom-one-dark.css?inline";
import evaAppStyles from "../eva/App.css?inline";
import presenceOrbStyles from "../eva/PresenceOrb.css?inline";
import App from "../eva/App";
import { installWebviewStyles } from "./installWebviewStyles";

// Register only the languages the transcript can render (mirrors eva-app
// src/main.tsx): omp tool output + Eva's replies are ts/tsx/bash/json/rust/python.
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("python", python);

const adapter = createHighlightJsAdapter(hljs);
const theme = createTheme({ primaryColor: "violet" });

/**
 * Boots the Eva panel surface: injects the Mantine core + code-highlight +
 * highlight.js theme + Eva styles as one inlined blob (matching the
 * agent-session/diff surface convention, so no separate stylesheet asset has to
 * be served under the file:// host), then renders the ported Eva `<App/>` inside
 * `MantineProvider` (forced dark, violet accent) and the highlight.js adapter.
 * Loaded as its own chunk so the diff and agent-session surfaces never ship the
 * Eva UI (Mantine, react-markdown, highlight.js).
 */
export function mountEvaSurface(rootElement: HTMLElement): void {
  installWebviewStyles(
    "eva",
    [
      mantineCoreStyles,
      mantineCodeHighlightStyles,
      hljsThemeStyles,
      evaAppStyles,
      presenceOrbStyles,
    ].join("\n"),
  );
  document.documentElement.dataset.cmuxWebviewKind = "agent-session";
  document.body.dataset.cmuxWebviewKind = "agent-session";
  createRoot(rootElement).render(
    <MantineProvider forceColorScheme="dark" theme={theme}>
      <CodeHighlightAdapterProvider adapter={adapter}>
        <App />
      </CodeHighlightAdapterProvider>
    </MantineProvider>,
  );
}
