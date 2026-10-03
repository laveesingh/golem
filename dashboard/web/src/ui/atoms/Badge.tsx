import { requireText } from './action.ts';
import './atoms.css';
export type BadgeProps = (
  | { count: number; max?: number; text?: never }
  | { text: string; count?: never; max?: never }
) & { label?: string };
export function Badge(props: BadgeProps) {
  if (props.text !== undefined) {
    requireText(props.text, 'Badge text');
    return (
      <span className="g-badge">
        {props.label ? (
          <span className="g-visually-hidden">{props.label}: </span>
        ) : null}
        {props.text}
      </span>
    );
  }
  const max = props.max ?? 99;
  if (
    !Number.isSafeInteger(props.count) ||
    props.count < 0 ||
    !Number.isSafeInteger(max) ||
    max < 1
  )
    throw new Error(
      'Badge count must be a nonnegative safe integer and max a positive safe integer',
    );
  const display = props.count > max ? `${max}+` : String(props.count);
  const accessible = props.label
    ? `${props.label}: ${props.count}`
    : String(props.count);
  return (
    <span className="g-badge">
      <span aria-hidden="true">{display}</span>
      <span className="g-visually-hidden">{accessible}</span>
    </span>
  );
}
