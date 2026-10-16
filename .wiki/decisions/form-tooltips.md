# Form hints live in tooltips, not under the field

**What:** `RemoteForm` (`frontend/src/components/RemoteForm.tsx`) prints no hint
paragraph. Every explanation sits in a `role="tooltip"` body behind a "?"
(`HintTip`, `frontend/src/components/HintTip.tsx`), and both the trigger and the
field's control point at it with `aria-describedby`. The descriptor `hint`
strings are reused verbatim; the backend is unchanged.

**Decisions a reader cannot re-derive:**

- **Not Radix Tooltip.** It unmounts its content while closed, so the input's
  `aria-describedby` would point at nothing, and it does not open on tap. The
  body is always in the DOM, toggled with the `hidden` attribute.
- **No `title` attribute.** It never appears on touch or keyboard focus, and cc is
  used on phones.
- **`aria-describedby` on the control too**, so tabbing into the field reads the
  hint without visiting the "?". Hidden content still counts for it.
- **Visibility is computed in JS:** `!dismissed && (open || kbd || (hovered && hoverCapable))`.
  - **Hover counts only under `matchMedia('(hover: hover)')`.** On touch, hover
    sticks after a tap and would pin the tip open next to the tap toggle.
  - **Keyboard show (`kbd`) is a focus that no `pointerdown` preceded**, the JS
    equivalent of `:focus-visible`: a mouse click focuses the button and would
    otherwise fight the click toggle. The pointer flag is cleared on click too,
    because a click on an already-focused "?" fires no focus to consume it.
- **`dismissed` beats every show reason** (WCAG 1.4.13). Escape and a body click
  set it. It is cleared by focus leaving, by `mouseenter` only while unfocused (so
  a mouse crossing cannot revive a keyboard dismissal), by a fresh focus (a body
  click blurs the "?" first, so Tab back must reveal the tip), or by clicking the "?".
- **The body is absolutely positioned under its `relative` label row**; cards do
  not clip overflow, so a tip near a card's bottom shows whole.
- **ssh Port/Password/Key file sit under Advanced.** See
  [advanced-group.md](advanced-group.md).
- The edit note keeps its consequence ("switches this remote off") visible; only
  the detail is in a tip.
