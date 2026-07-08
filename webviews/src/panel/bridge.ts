import type { PanelInitValue, SubmitValue } from "./spec";

// WebKit script-message bridge (frozen contract, Swift side built against it):
//   window.webkit.messageHandlers.cmuxPanel.postMessage({ method, params? })
//     -> Promise<{ ok: true, value } | { ok: false, error: { code, userMessage } }>
//
// The `webkit` window shape is deliberately typed through a local cast instead
// of `declare global`: agent-session/shared/bridge.ts already augments
// Window.webkit for its own handler, and a second augmentation with a
// different handler name would clash during typecheck.

type NativeReply = { ok: true; value: unknown } | { ok: false; error?: { code?: string; userMessage?: string } };

type PanelMessageHandler = { postMessage(message: unknown): Promise<NativeReply> };

type WebKitWindow = Window & {
  webkit?: { messageHandlers?: { cmuxPanel?: PanelMessageHandler } };
};

export class PanelBridgeError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PanelBridgeError";
    this.code = code;
  }
}

export type PanelBridge = {
  readonly mode: "native" | "demo";
  init(): Promise<PanelInitValue>;
  submit(value: SubmitValue): Promise<void>;
  cancel(): Promise<void>;
};

const HANDLER_RETRY_ATTEMPTS = 20;
const HANDLER_RETRY_INTERVAL_MS = 150;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Resolves the cmuxPanel message handler, briefly retrying to ride out the
 * window between page load and the app installing the handler.
 */
async function waitForHandler(win: WebKitWindow): Promise<PanelMessageHandler> {
  for (let attempt = 0; attempt < HANDLER_RETRY_ATTEMPTS; attempt += 1) {
    const handler = win.webkit?.messageHandlers?.cmuxPanel;
    if (handler && typeof handler.postMessage === "function") {
      return handler;
    }
    await delay(HANDLER_RETRY_INTERVAL_MS);
  }
  throw new PanelBridgeError("The panel bridge is unavailable.", "bridge_unavailable");
}

async function callPanel(win: WebKitWindow, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const handler = await waitForHandler(win);
  const message: { method: string; params?: Record<string, unknown> } = { method };
  if (params !== undefined) {
    message.params = params;
  }
  let reply: NativeReply;
  try {
    reply = await handler.postMessage(message);
  } catch (error) {
    throw new PanelBridgeError(error instanceof Error ? error.message : "The panel request failed.", "bridge_failure");
  }
  if (!reply || reply.ok !== true) {
    const failure = reply && reply.ok === false ? reply.error : undefined;
    throw new PanelBridgeError(failure?.userMessage || "The panel request failed.", failure?.code || "bridge_failure");
  }
  return reply.value;
}

export function createNativeBridge(win: WebKitWindow): PanelBridge {
  return {
    mode: "native",
    async init() {
      return (await callPanel(win, "panel.init")) as PanelInitValue;
    },
    async submit(value: SubmitValue) {
      await callPanel(win, "panel.submit", { value });
    },
    async cancel() {
      await callPanel(win, "panel.cancel");
    },
  };
}

/**
 * Browser fallback for development: `window.webkit` is absent outside
 * WKWebView, so the app renders a demo spec and logs bridge traffic.
 */
export function createDemoBridge(initValue: PanelInitValue): PanelBridge {
  return {
    mode: "demo",
    async init() {
      return initValue;
    },
    async submit(value: SubmitValue) {
      console.log("[cmux panel demo] panel.submit", JSON.stringify({ value }, null, 2));
    },
    async cancel() {
      console.log("[cmux panel demo] panel.cancel");
    },
  };
}

export function detectBridge(win: Window, demoInitValue: PanelInitValue): PanelBridge {
  if ((win as WebKitWindow).webkit === undefined) {
    return createDemoBridge(demoInitValue);
  }
  return createNativeBridge(win as WebKitWindow);
}
