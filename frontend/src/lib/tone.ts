// THE STATUS PALETTE, in one place. Status is success / warning / destructive,
// never `primary`: primary is cc's control colour, and a status that borrows it
// reads as a button. The primary FILL (Button `variant="default"`) is a form's
// Create/Save and nothing else.

/** A status word's text. Alerts and badges take theirs from their own variants. */
export const TONE = {
  ok: 'text-success',
  muted: 'text-muted-foreground',
} as const;

/** The probe dot, per `probeStatus(...).level`. */
export const DOT = {
  ok: 'bg-success',
  down: 'bg-warning',
  unknown: 'bg-muted-foreground',
} as const;

/** Connect: a quiet outline button tinted with the success colour, not a primary fill. */
export const GATE_ON_BUTTON = 'text-success border-success/45 hover:bg-success/10 hover:text-success';

/** Disconnect and Delete on a card: an outline button tinted with the destructive colour. */
export const DANGER_BUTTON = 'text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive';
