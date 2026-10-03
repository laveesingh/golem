import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { IconButton } from '../../dashboard/web/src/ui/atoms/IconButton.tsx';

const icon = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 5v14" />
  </svg>
);
test('named native control hides decorative glyph and supports keyboard', async () => {
  const click = vi.fn();
  render(<IconButton label="Add item" icon={icon} onClick={click} />);
  const button = screen.getByRole('button', { name: 'Add item' });
  expect(button).toHaveAttribute('type', 'button');
  expect(button).toHaveAttribute('data-variant', 'quiet');
  expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  expect(button.querySelector('svg')).toHaveAttribute('focusable', 'false');
  await userEvent.tab();
  await userEvent.keyboard('{Enter} ');
  expect(click).toHaveBeenCalledTimes(2);
});
test('busy retains focus and suppresses actions; native disabled wins', async () => {
  const click = vi.fn();
  const view = render(
    <IconButton label="Add item" icon={icon} onClick={click} />,
  );
  await userEvent.tab();
  const button = screen.getByRole('button');
  view.rerender(
    <IconButton label="Add item" icon={icon} busy onClick={click} />,
  );
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(button).toHaveAccessibleName('Add item');
  expect(button.querySelector('[data-busy-indicator]')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  expect(button.querySelector('.g-icon-original svg')).toBeInTheDocument();
  await userEvent.click(button);
  await userEvent.keyboard('{Enter} ');
  expect(click).not.toHaveBeenCalled();
  view.rerender(
    <IconButton label="Add item" icon={icon} busy disabled onClick={click} />,
  );
  expect(button).toBeDisabled();
  expect(button).not.toHaveAttribute('aria-busy');
});
test('blank name or interactive/non-SVG icon rejected', () => {
  expect(() => render(<IconButton label=" " icon={icon} />)).toThrow(
    /nonempty/,
  );
  expect(() =>
    render(
      <IconButton
        label="Bad"
        icon={
          <svg aria-hidden="true" focusable="false">
            <foreignObject>
              <button type="button">Bad</button>
            </foreignObject>
          </svg>
        }
      />,
    ),
  ).toThrow(/noninteractive/);
});
