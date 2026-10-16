import { useRef, useState } from 'react';
import { CircleHelpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

const hoverCapable = () => window.matchMedia?.('(hover: hover)').matches === true;

/**
 * A "?" beside a label that opens a field's explanation. Place it in a `relative` row: the body is
 * positioned under that row. The body is always in the DOM (`hidden` until shown), so the trigger AND
 * the field's input can point at it with `aria-describedby` and a screen reader reads the hint from
 * the input. Not `title`, and not Radix Tooltip: neither shows on tap, and Radix unmounts the content
 * while closed, which breaks the input's `aria-describedby`.
 *
 * Shown by a tap or click (`open`), by keyboard focus (`kbd`: a focus no pointerdown preceded), or by
 * hover where hover is real (on touch, hover sticks after a tap). Escape or a click on the body
 * dismisses it, even under hover. A dismissal holds until focus leaves, a hover begins while the tip
 * is unfocused, a fresh focus arrives, or the "?" is clicked again.
 */
export function HintTip({ id, name, text }: { id: string; name: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [kbd, setKbd] = useState(false);
  const pointer = useRef(false);

  const dismiss = () => { setOpen(false); setDismissed(true); };
  const visible = !dismissed && (open || kbd || (hovered && hoverCapable()));

  return (
    <span
      className="inline-flex"
      data-open={open}
      data-dismissed={dismissed}
      onKeyDown={(e) => { if (e.key === 'Escape') dismiss(); }}
      onFocus={() => {
        setFocused(true);
        setDismissed(false);
        setKbd(!pointer.current);
        pointer.current = false;
      }}
      onBlur={() => { setFocused(false); setOpen(false); setDismissed(false); setKbd(false); }}
      onMouseEnter={() => { setHovered(true); if (!focused) setDismissed(false); }}
      onMouseLeave={() => setHovered(false)}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-5 rounded-full text-muted-foreground"
        aria-label={`About ${name}`}
        aria-describedby={id}
        onPointerDown={() => { pointer.current = true; }}
        onClick={() => {
          // A click on an already-focused "?" fires no focus to consume the pointerdown.
          pointer.current = false;
          setDismissed(false);
          setOpen((o) => !o);
        }}
      >
        <CircleHelpIcon className="size-3.5" />
      </Button>
      <span
        role="tooltip"
        id={id}
        hidden={!visible}
        onClick={dismiss}
        className="absolute top-full right-0 left-0 z-20 mt-1 rounded-md border bg-popover p-2 text-xs font-normal text-popover-foreground shadow-md"
      >
        {text}
      </span>
    </span>
  );
}
