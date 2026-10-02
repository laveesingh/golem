import type { ReactElement, SVGProps } from 'react';
import { Children, cloneElement, isValidElement } from 'react';
import type { ActionProps } from './action.ts';
import { actionClick, actionKey, requireText } from './action.ts';
import './atoms.css';

export interface IconButtonProps extends ActionProps {
  icon: ReactElement<SVGProps<SVGSVGElement>>;
}
const shapes = new Set([
  'svg',
  'path',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'g',
  'defs',
  'use',
]);
function decorativeGlyph(element: ReactElement): void {
  if (typeof element.type !== 'string' || !shapes.has(element.type))
    throw new Error('IconButton requires a noninteractive inline SVG glyph');
  const props = element.props as {
    children?: unknown;
    tabIndex?: number;
    onClick?: unknown;
    style?: unknown;
  };
  if (
    (props.tabIndex !== undefined && props.tabIndex >= 0) ||
    Object.keys(element.props).some((key) => /^on[A-Z]/.test(key)) ||
    props.style
  )
    throw new Error(
      'IconButton glyph cannot contain interactive or inline-style props',
    );
  Children.forEach(props.children as ReactElement[], (child) => {
    if (isValidElement(child)) decorativeGlyph(child);
  });
}
export function IconButton(props: IconButtonProps) {
  requireText(props.label, 'IconButton accessible label');
  if (props.icon.type !== 'svg')
    throw new Error('IconButton requires an inline SVG root');
  decorativeGlyph(props.icon);
  return (
    <button
      className="g-button g-icon-button"
      data-variant={props.variant ?? 'quiet'}
      data-busy={props.busy && !props.disabled ? 'true' : undefined}
      id={props.id}
      name={props.name}
      type={props.type ?? 'button'}
      disabled={props.disabled}
      aria-label={props.label}
      aria-busy={props.busy && !props.disabled ? true : undefined}
      aria-disabled={props.busy && !props.disabled ? true : undefined}
      aria-describedby={props.describedBy}
      onClick={(event) => actionClick(props, event)}
      onKeyDown={(event) => actionKey(props, event)}
    >
      <span className="g-icon-glyph" aria-hidden="true">
        <span className="g-icon-original">
          {cloneElement(props.icon, {
            'aria-hidden': true,
            focusable: 'false',
            tabIndex: -1,
          })}
        </span>
        <span
          className="g-busy-cue g-icon-cue"
          data-busy-indicator="static-hourglass"
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4 2h8v2l-4 4 4 4v2H4v-2l4-4-4-4Z" />
          </svg>
        </span>
      </span>
    </button>
  );
}
