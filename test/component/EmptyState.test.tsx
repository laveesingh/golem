import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { EmptyState } from '../../dashboard/web/src/ui/molecules/EmptyState.tsx';

test('EmptyState supplies a heading and description without unsolicited live announcements', () => {
  const { container } = render(
    <EmptyState
      title="No tasks"
      description="Create one"
      actions={<button type="button">Create</button>}
    />,
  );
  expect(screen.getByRole('heading', { name: 'No tasks' })).toBeVisible();
  expect(screen.getByText('Create one')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  expect(container.querySelector('[aria-live], [role=status]')).toBeNull();
});
