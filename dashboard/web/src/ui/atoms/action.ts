import type { KeyboardEvent, MouseEvent, MouseEventHandler } from 'react';

type ActionType = 'button' | 'submit' | 'reset';
type ActionVariant = 'primary' | 'quiet';
export interface ActionProps {
  label: string;
  id?: string;
  name?: string;
  type?: ActionType;
  variant?: ActionVariant;
  busy?: boolean;
  disabled?: boolean;
  describedBy?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}
export function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} requires nonempty text`);
}
export function actionClick(
  props: ActionProps,
  event: MouseEvent<HTMLButtonElement>,
): void {
  if (props.busy || props.disabled) {
    event.preventDefault();
    return;
  }
  props.onClick?.(event);
}
export function actionKey(
  props: ActionProps,
  event: KeyboardEvent<HTMLButtonElement>,
): void {
  if ((props.busy || props.disabled) && ['Enter', ' '].includes(event.key))
    event.preventDefault();
}
