import { type KeyboardEvent, useState } from "react";
import { Textarea } from "@mantine/core";

/**
 * Standalone multiline chat composer (CHAT-05).
 *
 * A Mantine autosize `Textarea` that grows with content up to `maxRows` then
 * scrolls. Enter (no modifier) sends the trimmed draft; Shift+Enter falls
 * through to the textarea's default newline insertion. Enter pressed mid-IME
 * composition never sends (Pitfall 11 — the IME composition guard). The
 * composer is inert while `disabled` (the not-ready / streaming gate): the
 * textarea is visibly disabled by Mantine and the send path bails.
 *
 * Two-prop drop-in for the transcript surface wired up in 02-07.
 */
export function Composer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline (default). Never submit while a
    // CJK/autocomplete composition is in flight — that Enter confirms the
    // composition, it is not a send.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (disabled) return; // not-ready / streaming gate
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  return (
    <Textarea
      className="chat-input"
      autosize
      minRows={1}
      maxRows={8}
      autoFocus
      disabled={disabled}
      placeholder={placeholder ?? "Message Eva"}
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={handleKeyDown}
    />
  );
}
