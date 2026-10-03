import type { ChangeEventHandler } from 'react';
import { requireText } from './action.ts';
import './atoms.css';

interface InputBase {
  id: string;
  label: string;
  name?: string;
  type?: 'text' | 'search' | 'email' | 'password';
  placeholder?: string;
  error?: string;
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  autoComplete?: string;
  describedBy?: string;
}
type InputValue =
  | {
      value: string;
      onChange: ChangeEventHandler<HTMLInputElement>;
      defaultValue?: never;
    }
  | {
      value?: never;
      defaultValue?: string;
      onChange?: ChangeEventHandler<HTMLInputElement>;
    };
export type InputProps = InputBase & InputValue;
export function Input(props: InputProps) {
  requireText(props.id, 'Input id');
  requireText(props.label, 'Input visible label');
  const error = props.error?.trim() ? props.error : undefined;
  const described =
    [props.describedBy, error ? `${props.id}-error` : undefined]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className="g-input-field">
      <label className="g-input-label" htmlFor={props.id}>
        {props.label}
        {props.required ? ' (required)' : ''}
      </label>
      <input
        className="g-input"
        id={props.id}
        name={props.name}
        type={props.type ?? 'text'}
        placeholder={props.placeholder}
        value={props.value}
        defaultValue={props.defaultValue}
        onChange={props.onChange}
        disabled={props.disabled}
        readOnly={props.readOnly}
        required={props.required}
        autoComplete={props.autoComplete}
        aria-invalid={props.invalid || error ? true : undefined}
        aria-describedby={described}
      />
      {error ? (
        <span className="g-input-error" id={`${props.id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
