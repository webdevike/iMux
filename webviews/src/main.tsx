import { callNative } from "./agent-session/shared/bridge";

type WebviewKind = "agent-session" | "diff";

function resolveWebviewKind(): WebviewKind {
  if (
    document.documentElement.dataset.cmuxWebviewKind === "agent-session" ||
    document.body.dataset.cmuxWebviewKind === "agent-session" ||
    document.getElementById("cmux-agent-session-config")
  ) {
    return "agent-session";
  }
  return "diff";
}

// The active agent provider is not baked into the host HTML, so it is only
// knowable after an `app.context` bridge call. A synchronous hint (a
// `data-cmux-agent-provider` attribute or a `#cmux-agent-session-config` JSON
// blob) is honored first if the host ever bakes one in, sparing the round-trip;
// otherwise fall back to `app.context.initialProviderId`.
function syncProviderHint(): string | null {
  const attr =
    document.documentElement.dataset.cmuxAgentProvider ?? document.body.dataset.cmuxAgentProvider;
  if (attr) return attr;
  const raw = document.getElementById("cmux-agent-session-config")?.textContent?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const config = parsed as Record<string, unknown>;
        const provider = config.provider ?? config.initialProviderId;
        if (typeof provider === "string") return provider;
      }
    } catch {
      // Malformed config -> fall through to the bridge lookup.
    }
  }
  return null;
}

async function resolveAgentProvider(): Promise<string | null> {
  const hint = syncProviderHint();
  if (hint) return hint;
  try {
    const context = await callNative<{ initialProviderId?: string }>("app.context");
    return typeof context.initialProviderId === "string" ? context.initialProviderId : null;
  } catch {
    return null;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing cmux webview root");
}

// Load only the active surface so each one ships as its own chunk: the diff
// viewer pulls in `@pierre/diffs`, the agent session pulls in its editor UI, the
// Eva panel pulls in Mantine + react-markdown + highlight.js, and none pays for
// the others. Shared vendor code (React, the router) is hoisted by Rollup into
// chunks the surfaces reuse.
if (resolveWebviewKind() === "agent-session") {
  void resolveAgentProvider().then((provider) => {
    if (provider === "eva") {
      void import("./surfaces/evaSurface").then((surface) => {
        surface.mountEvaSurface(rootElement);
      });
    } else {
      void import("./surfaces/agentSessionSurface").then((surface) => {
        surface.mountAgentSessionSurface(rootElement);
      });
    }
  });
} else {
  void import("./surfaces/diffSurface").then((surface) => {
    surface.mountDiffSurface(rootElement);
  });
}
