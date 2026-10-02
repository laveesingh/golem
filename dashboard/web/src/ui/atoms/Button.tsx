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
    </button>
  );
}
