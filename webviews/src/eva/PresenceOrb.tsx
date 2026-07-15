/**
 * Eva's presence anchor. A single, reducer-derived presence value drives all
 * three visuals (D-07) so the orb can never disagree with the transcript:
 *   idle        = dim, steady, no motion
 *   working     = a calm pulse (Eva is thinking / streaming)
 *   needs-input = an insistent accent attention pulse (your input is required)
 *
 * Purely presentational: one prop in, one styled element out. No reducer, no
 * timers, no omp imports, no pointer handlers. Its stylesheet is injected once
 * by the surface (installWebviewStyles), so this component takes no side-effect
 * CSS import.
 */
export type PresenceState = "idle" | "working" | "needs-input";

const stateClass: Record<PresenceState, string> = {
  idle: "presence-orb--idle",
  working: "presence-orb--working",
  "needs-input": "presence-orb--needs-input",
};

export function PresenceOrb({ state }: { state: PresenceState }) {
  return (
    <span
      className={`presence-orb ${stateClass[state]}`}
      role="img"
      aria-label={`Eva presence: ${state}`}
    />
  );
}
