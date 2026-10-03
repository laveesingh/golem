import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { Badge } from '../../dashboard/web/src/ui/atoms/Badge.tsx';

test('zero shown; overflow keeps full accessible count without duplicate numeric announcement', () => {
  const view = render(<Badge count={0} label="Items" />);
  expect(screen.getByText('0')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByText('Items: 0')).not.toHaveAttribute('aria-hidden');
  view.rerender(<Badge count={1234} label="Items" />);
  expect(screen.getByText('99+')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByText('Items: 1234')).not.toHaveAttribute('aria-hidden');
  expect(screen.queryByRole('button')).toBeNull();
});
test('custom max and text-only are plain readable meaning', () => {
  const view = render(<Badge count={8} max={5} />);
  expect(screen.getByText('5+')).toBeInTheDocument();
  expect(screen.getByText('8')).toBeInTheDocument();
  view.rerender(<Badge text="Review required" />);
  expect(screen.getByText('Review required')).toBeVisible();
});
test('invalid numeric counts/max and empty text rejected', () => {
  for (const count of [-1, 1.5, NaN, Infinity])
    expect(() => render(<Badge count={count} />)).toThrow(/safe integer/);
  expect(() => render(<Badge count={2} max={0} />)).toThrow(/positive/);
  expect(() => render(<Badge text="" />)).toThrow(/nonempty/);
});
