import type { FocusEvent, KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import './molecules.css';
export type MenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};
export function Menu({
  label,
  items,
  disabled = false,
}: {
  label: string;
  items: readonly MenuItem[];
  disabled?: boolean;
}) {
  if (
    !label.trim() ||
    items.some((item) => !item.label.trim() || !item.id) ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw Error(
      'Menu requires a label and uniquely identified labelled actions',
    );
  const [open, setOpen] = useState(false),
    id = useId(),
    trigger = useRef<HTMLButtonElement>(null),
    root = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLDivElement>(null),
    buttons = useRef<Array<HTMLButtonElement | null>>([]),
    start = useRef(0);
  const enabled = items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index !== -1);
  function close(restore = true) {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }
  function show(last = false) {
    start.current = last ? (enabled.at(-1) ?? -1) : (enabled[0] ?? -1);
    setOpen(true);
  }
  useEffect(() => {
    if (open) {
      if (start.current < 0) panel.current?.focus();
      else buttons.current[start.current]?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // Restore the trigger, then let the keypress carry focus outward.
      close();
      return;
    }
    const current = buttons.current.indexOf(
        document.activeElement as HTMLButtonElement | null,
      ),
      offset = enabled.indexOf(current);
    let target: number | undefined;
    if (event.key === 'ArrowDown')
      target = enabled[(offset + 1) % enabled.length];
    else if (event.key === 'ArrowUp')
      target = enabled[(offset - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') target = enabled[0];
    else if (event.key === 'End') target = enabled.at(-1);
    else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      target = [
        ...enabled.slice(offset + 1),
        ...enabled.slice(0, offset + 1),
      ].find((index) =>
        items[index]?.label
          .toLocaleLowerCase()
          .startsWith(event.key.toLocaleLowerCase()),
      );
    } else return;
    event.preventDefault();
    if (target !== undefined) buttons.current[target]?.focus();
  }
  function blur(event: FocusEvent) {
    if (
      event.relatedTarget instanceof Node &&
      !root.current?.contains(event.relatedTarget)
    )
      setOpen(false);
  }
  return (
    <div className="g-menu" ref={root}>
      <button
        className="g-menu-trigger"
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onBlur={blur}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            show(event.key === 'ArrowUp');
          }
        }}
      >
        {label}
      </button>
      {open && (
        <div
          className="g-menu-panel"
          id={id}
          role="menu"
          aria-label={label}
          ref={panel}
          tabIndex={-1}
          onBlur={blur}
          onKeyDown={key}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                buttons.current[index] = node;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
