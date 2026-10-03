import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { ListRow } from '../../dashboard/web/src/ui/molecules/ListRow.tsx';

test('ListRow is not a fake action without a handler', () => {
  render(<ListRow title="Task" description="Details" meta="Review" />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('Details')).toBeVisible();
});
test('native row activates with keyboard, conveys selection and blocks disabled activation', async () => {
  const fn = vi.fn(),
    user = userEvent.setup();
  const { rerender } = render(
    <ListRow title="Task" selected onActivate={fn} />,
  );
  const row = screen.getByRole('button', { name: 'Task' });
  expect(row).toHaveAttribute('aria-pressed', 'true');
  await user.tab();
  await user.keyboard('{Enter}');
  expect(fn).toHaveBeenCalledTimes(1);
  rerender(<ListRow title="Task" disabled onActivate={fn} />);
  await user.click(row);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(row).toBeDisabled();
});
