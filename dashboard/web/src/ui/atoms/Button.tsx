import type { ActionProps } from './action.ts';
import { actionClick, actionKey, requireText } from './action.ts';
import './atoms.css';

export function Button(props: ActionProps) {
  requireText(props.label, 'Button label');
  return (
    <button
      className="g-button"
      data-variant={props.variant ?? 'primary'}
      data-busy={props.busy && !props.disabled ? 'true' : undefined}
      id={props.id}
      name={props.name}
      type={props.type ?? 'button'}
      disabled={props.disabled}
      aria-busy={props.busy && !props.disabled ? true : undefined}
      aria-disabled={props.busy && !props.disabled ? true : undefined}
      aria-describedby={props.describedBy}
      onClick={(event) => actionClick(props, event)}
      onKeyDown={(event) => actionKey(props, event)}
    >
      {props.label}
      <span
        className="g-busy-cue"
        aria-hidden="true"
        data-busy-indicator="static-hourglass"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M4 2h8v2l-4 4 4 4v2H4v-2l4-4-4-4Z" />
        </svg>
      </span>
    </button>
  );
}
