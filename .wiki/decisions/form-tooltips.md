# Form hints live in tooltips, not under the field

**What:** `formFor` (`frontend/app.js`) prints no `.hint` paragraph. Every
explanation sits in a `role="tooltip"` body behind a "?" (`tip()`), and both the
trigger and the field's input point at it with `aria-describedby`. The descriptor
`hint` strings are reused verbatim; the backend is unchanged.

**Decisions a reader cannot re-derive:**

- **No `title` attribute.** It never appears on touch or keyboard focus, and cc is
  used on phones.
- **`aria-describedby` on the input too**, so tabbing into the field reads the
  hint without visiting the "?". `display: none` content still counts for it.
- **Hover is wrapped in `@media (hover: hover)`.** On touch, `:hover` sticks after
  a tap and would pin the tip open next to the `.open` toggle.
- **Keyboard show is `:focus-visible`**, not `:focus`: a mouse click focuses the
  button and would fight the click toggle.
- **`.tip.dismissed` must be declared last.** It ties the show rules on
  specificity, so source order is what makes Escape win (WCAG 1.4.13). A body
  click sets it too, because `:hover` would otherwise keep the tip shown. It is
  cleared by `focusout`, by `mouseenter` only while the tip is unfocused (so a
  mouse crossing cannot revive a keyboard dismissal), by a fresh `focusin` (a body
  click blurs the "?" first, so Tab back must reveal the tip), or by clicking the "?".
- **`.card:has(.form)` lifts `overflow: hidden`** so a tip near the card's bottom
  is not clipped.
- **ssh Port/Password/Key file stay in the main block.** Moving them under
  Advanced needs `advanced: true` in the ssh descriptor, a backend change, and
  would put auth fields beside mirror policy.
- The edit note keeps its consequence ("switches this remote off") visible; only
  the detail is in a tip.
