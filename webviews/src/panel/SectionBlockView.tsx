import { Textarea } from "@mantine/core";
import React from "react";
import { MarkdownView } from "./MarkdownView";
import type { SectionBlock, SectionStatus } from "./spec";

/** User-owned section state; lives in the app so spec updates can reconcile it. */
export type SectionUiState = { status: SectionStatus; comment: string };

export function initialSectionState(block: SectionBlock): SectionUiState {
  return { status: block.status ?? "proposed", comment: "" };
}

type SectionBlockViewProps = {
  block: SectionBlock;
  state: SectionUiState;
  onStateChange: (next: SectionUiState) => void;
};

export function SectionBlockView({ block, state, onStateChange }: SectionBlockViewProps) {
  const decidable = block.decidable !== false;
  const commentable = block.commentable !== false;

  // Clicking the active side clears the decision back to "proposed".
  const decide = (target: "approved" | "rejected") => {
    onStateChange({ ...state, status: state.status === target ? "proposed" : target });
  };

  return (
    <section className="panel-section" data-section-id={block.id} data-status={state.status}>
      {block.heading || state.status !== "none" ? (
        <div className="panel-section-header">
          {block.heading ? <h2 className="panel-section-heading">{block.heading}</h2> : null}
          {state.status !== "none" ? (
            <span className={`panel-section-chip is-${state.status}`}>{state.status}</span>
          ) : null}
        </div>
      ) : null}
      <MarkdownView text={block.markdown} />
      {decidable || commentable ? (
        <div className="panel-section-controls">
          {decidable ? (
            <div className="panel-section-decide" role="group" aria-label={`Decision for ${block.heading ?? block.id}`}>
              <button
                type="button"
                className="panel-section-approve"
                aria-pressed={state.status === "approved"}
                onClick={() => decide("approved")}
              >
                Approve
              </button>
              <button
                type="button"
                className="panel-section-reject"
                aria-pressed={state.status === "rejected"}
                onClick={() => decide("rejected")}
              >
                Reject
              </button>
            </div>
          ) : null}
          {commentable ? (
            <Textarea
              className="panel-section-comment"
              size="xs"
              autosize
              minRows={1}
              maxRows={6}
              placeholder="Add a note for the agent…"
              aria-label={`Note for ${block.heading ?? block.id}`}
              value={state.comment}
              onChange={(event) => onStateChange({ ...state, comment: event.currentTarget.value })}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
