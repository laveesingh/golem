import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { PillStatus } from '../../dashboard/web/src/ui/atoms/Pill.tsx';
import { Pill } from '../../dashboard/web/src/ui/atoms/Pill.tsx';

test('all statuses have visible text and decorative dots without duplicate announcements', () => {
  const statuses: ReadonlyArray<PillStatus> = [
    'neutral',
    'working',
    'idle',
    'review',
    'blocked',
    'done',
    'triage',
    'open',
  ] as const;
  for (const status of statuses) {
    const view = render(<Pill status={status} />);
    const text = screen.getByText(status[0].toUpperCase() + status.slice(1));
    expect(text).toHaveAttribute('data-status', status);
    expect(text.querySelector('.g-status-dot')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(text).not.toHaveAttribute('role');
    expect(text).not.toHaveAttribute('aria-live');
    expect(screen.queryByRole('button')).toBeNull();
    view.unmount();
  }
});
test('long custom label retained and empty text rejected', () => {
  render(
    <Pill status="working" label="Working on a very long descriptive item" />,
  );
  expect(
    screen.getByText('Working on a very long descriptive item'),
  ).toBeVisible();
  expect(() => render(<Pill label="" />)).toThrow(/nonempty/);
});
