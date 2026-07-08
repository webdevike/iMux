import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { PanelApp } from "../src/panel/App";
import type { PanelBridge } from "../src/panel/bridge";
import type { PanelInitValue, SubmitValue } from "../src/panel/spec";

let root: Root | null = null;
let dom: JSDOM | null = null;

// bun test has no DOM; jsdom globals are installed per test and restored after.
const globalRecord = globalThis as unknown as Record<string, unknown>;
const GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "Element",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLStyleElement",
  "customElements",
  "matchMedia",
  "ResizeObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originalGlobals = new Map<string, unknown>();
for (const key of GLOBAL_KEYS) {
  originalGlobals.set(key, globalRecord[key]);
}

afterEach(async () => {
  if (root) {
    flushSync(() => root?.unmount());
  }
  root = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom?.window.close();
  dom = null;
  for (const [key, value] of originalGlobals) {
    if (value === undefined) {
      delete globalRecord[key];
    } else {
      globalRecord[key] = value;
    }
  }
});

function installDom(): Document {
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://127.0.0.1/panel",
    // Gives jsdom a requestAnimationFrame loop (Mantine's Transition uses it).
    pretendToBeVisual: true,
  });
  // jsdom window is structurally a Window; the record view lets us install shims.
  const win = dom.window as unknown as Record<string, unknown>;
  // Mantine touches matchMedia for color-scheme handling; jsdom lacks both shims.
  win.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  win.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // react-dom feature-detects input events at module load, where no DOM
  // exists under bun test; it then falls back to the IE propertychange
  // polyfill on focus, which calls attachEvent/detachEvent. No-op them.
  const elementProto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  elementProto.attachEvent = () => {};
  elementProto.detachEvent = () => {};
  for (const key of GLOBAL_KEYS) {
    globalRecord[key] = win[key];
  }
  return dom.window.document;
}

function renderPanel(element: React.ReactNode): void {
  const container = dom?.window.document.getElementById("root");
  expect(container).toBeTruthy();
  root = createRoot(container!);
  flushSync(() => {
    root?.render(element);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > timeoutAt) {
      throw new Error("Timed out waiting for panel assertion");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

type FakeBridgeCalls = {
  submits: SubmitValue[];
  cancels: number;
};

function fakeBridge(
  initValue: PanelInitValue,
  overrides: Partial<Pick<PanelBridge, "submit" | "cancel">> = {},
): { bridge: PanelBridge; calls: FakeBridgeCalls } {
  const calls: FakeBridgeCalls = { submits: [], cancels: 0 };
  const bridge: PanelBridge = {
    mode: "native",
    async init() {
      return initValue;
    },
    async submit(value: SubmitValue) {
      calls.submits.push(value);
      await overrides.submit?.(value);
    },
    async cancel() {
      calls.cancels += 1;
      await overrides.cancel?.();
    },
  };
  return { bridge, calls };
}

function treeFixture(): PanelInitValue {
  return {
    title: "Fixture panel",
    spec: {
      body: [
        { type: "markdown", text: "# Plan" },
        {
          type: "tree",
          id: "files",
          nodes: [
            {
              id: "src",
              label: "src",
              children: [
                { id: "src/a.ts", label: "a.ts", note: "new" },
                { id: "src/b.ts", label: "b.ts", included: false },
              ],
            },
            { id: "README.md", label: "README.md" },
          ],
        },
        {
          type: "tree",
          id: "options",
          features: ["toggle"],
          nodes: [{ id: "opt/x", label: "x" }],
        },
      ],
    },
  };
}

function row(id: string): HTMLElement {
  const element = dom?.window.document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  expect(element).toBeTruthy();
  return element!;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  // React tracks input values through the prototype setter; assigning
  // input.value directly would be swallowed by its change dedup.
  const setter = Object.getOwnPropertyDescriptor(dom!.window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new dom!.window.Event("input", { bubbles: true }));
}

function buttonLabeled(label: string): HTMLButtonElement {
  const button = Array.from(dom?.window.document.querySelectorAll("button") ?? []).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function dispatch(target: Element, event: Event): void {
  flushSync(() => {
    target.dispatchEvent(event);
  });
}

test("without window.webkit the demo spec renders every feature surface", async () => {
  const document = installDom();
  renderPanel(<PanelApp />);
  await waitFor(() => document.querySelector(".panel-title") !== null);

  expect(document.querySelector(".panel-title")?.textContent).toBe("Apply refactor to src/?");
  expect(document.querySelector(".panel-demo-badge")?.textContent).toBe("demo");
  // Markdown block: heading, inline code, fenced code, list, link.
  expect(document.querySelector(".panel-markdown h2")?.textContent).toBe("Refactor summary");
  expect(document.querySelector(".panel-md-pre code")?.textContent).toContain("moveNode");
  expect(document.querySelectorAll(".panel-markdown ul li").length).toBe(3);
  expect(document.querySelector(".panel-md-link")?.getAttribute("title")).toBe("https://example.com/plan");
  // Tree rows with notes, exclusion, and folder markers.
  expect(row("src/helpers.ts").querySelector(".panel-tree-note")?.textContent).toBe("renamed from utils.ts");
  expect(row("src/legacy.ts").className).toContain("is-excluded");
  expect(row("src").getAttribute("aria-expanded")).toBe("true");
  // Feature gating: the options tree is toggle-only.
  expect(row("opt/changelog").getAttribute("draggable")).toBe("false");
  expect(row("src/helpers.ts").getAttribute("draggable")).toBe("true");
  expect(row("opt/changelog").querySelector("input[type=checkbox]")).toBeTruthy();
  // Footer actions present.
  expect(buttonLabeled("Submit").disabled).toBe(false);
  expect(buttonLabeled("Cancel").disabled).toBe(false);
});

test("double-click rename commits on Enter and lands in the submit payload", async () => {
  const document = installDom();
  const { bridge, calls } = fakeBridge(treeFixture());
  renderPanel(<PanelApp bridge={bridge} />);
  await waitFor(() => document.querySelector("[data-node-id='src/a.ts']") !== null);

  const label = row("src/a.ts").querySelector(".panel-tree-label")!;
  dispatch(label, new dom!.window.MouseEvent("dblclick", { bubbles: true }));
  const input = document.querySelector<HTMLInputElement>(".panel-tree-rename input");
  expect(input).toBeTruthy();
  expect(input!.value).toBe("a.ts");

  flushSync(() => setInputValue(input!, "renamed.ts"));
  dispatch(input!, new dom!.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitFor(() => row("src/a.ts").textContent?.includes("renamed.ts") === true);
  expect(document.querySelector(".panel-tree-rename")).toBeNull();

  dispatch(buttonLabeled("Submit"), new dom!.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => calls.submits.length === 1);
  expect(calls.submits[0]).toEqual({
    files: {
      nodes: [
        {
          id: "src",
          label: "src",
          children: [
            { id: "src/a.ts", label: "renamed.ts", note: "new" },
            { id: "src/b.ts", label: "b.ts", included: false },
          ],
        },
        { id: "README.md", label: "README.md" },
      ],
    },
    options: { nodes: [{ id: "opt/x", label: "x" }] },
  });
});

test("escape reverts an in-progress rename", async () => {
  const document = installDom();
  const { bridge } = fakeBridge(treeFixture());
  renderPanel(<PanelApp bridge={bridge} />);
  await waitFor(() => document.querySelector("[data-node-id='src/a.ts']") !== null);

  dispatch(
    row("src/a.ts").querySelector(".panel-tree-label")!,
    new dom!.window.MouseEvent("dblclick", { bubbles: true }),
  );
  const input = document.querySelector<HTMLInputElement>(".panel-tree-rename input")!;
  flushSync(() => setInputValue(input, "nope.ts"));
  dispatch(input, new dom!.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  await waitFor(() => document.querySelector(".panel-tree-rename") === null);
  expect(row("src/a.ts").textContent).toContain("a.ts");
  expect(row("src/a.ts").textContent).not.toContain("nope.ts");
});

test("unchecking a folder dims descendants without unchecking them", async () => {
  const document = installDom();
  const { bridge, calls } = fakeBridge(treeFixture());
  renderPanel(<PanelApp bridge={bridge} />);
  await waitFor(() => document.querySelector("[data-node-id='src']") !== null);

  const folderCheckbox = row("src").querySelector<HTMLInputElement>("input[type=checkbox]")!;
  expect(folderCheckbox.checked).toBe(true);
  flushSync(() => folderCheckbox.click());

  await waitFor(() => row("src/a.ts").className.includes("is-ancestor-excluded"));
  expect(row("src").className).toContain("is-excluded");
  // Descendant keeps its own checkbox state — dimmed, not unchecked.
  expect(row("src/a.ts").querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);

  dispatch(buttonLabeled("Submit"), new dom!.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => calls.submits.length === 1);
  const files = calls.submits[0].files.nodes;
  expect(files[0].included).toBe(false);
  expect(files[0].children?.[0].included).toBeUndefined();
});

test("buttons disable while submit is in flight and stay disabled after native ok", async () => {
  const document = installDom();
  const gate = Promise.withResolvers<void>();
  const { bridge, calls } = fakeBridge(treeFixture(), { submit: () => gate.promise });
  renderPanel(<PanelApp bridge={bridge} />);
  await waitFor(() => document.querySelector("[data-node-id='src']") !== null);

  dispatch(buttonLabeled("Submit"), new dom!.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => calls.submits.length === 1);
  expect(buttonLabeled("Submit").disabled).toBe(true);
  expect(buttonLabeled("Cancel").disabled).toBe(true);

  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Native mode: the app owns closing the panel, controls stay disabled.
  expect(buttonLabeled("Submit").disabled).toBe(true);
});

test("a rejected submit shows an inline error and re-enables the controls", async () => {
  const document = installDom();
  const { bridge } = fakeBridge(treeFixture(), {
    submit: () => Promise.reject(new Error("tree write failed")),
  });
  renderPanel(<PanelApp bridge={bridge} />);
  await waitFor(() => document.querySelector("[data-node-id='src']") !== null);

  dispatch(buttonLabeled("Submit"), new dom!.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => document.querySelector(".panel-footer-error") !== null);
  expect(document.querySelector(".panel-footer-error")?.textContent).toBe("tree write failed");
  expect(buttonLabeled("Submit").disabled).toBe(false);
  expect(buttonLabeled("Cancel").disabled).toBe(false);
});

test("cancel posts panel.cancel", async () => {
  const document = installDom();
  const { bridge, calls } = fakeBridge(treeFixture());
  renderPanel(<PanelApp bridge={bridge} />);
  await waitFor(() => document.querySelector("[data-node-id='src']") !== null);

  dispatch(buttonLabeled("Cancel"), new dom!.window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => calls.cancels === 1);
});

test("a failed init renders the centered error state", async () => {
  const document = installDom();
  const bridge: PanelBridge = {
    mode: "native",
    init: () => Promise.reject(new Error("The panel bridge is unavailable.")),
    submit: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
  renderPanel(<PanelApp bridge={bridge} />);

  await waitFor(() => document.querySelector(".panel-error") !== null);
  expect(document.querySelector(".panel-error")?.textContent).toContain("The panel bridge is unavailable.");
  expect(document.querySelector(".panel-footer-actions")).toBeNull();
});
