import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  Card,
  CardHeader,
} from '../../dashboard/web/src/ui/molecules/Card.tsx';

test('Card labels its article by its heading and keeps accessible content/actions', () => {
  render(
    <Card
      title="Summary"
      description="Details"
      actions={<button type="button">Review</button>}
    >
      <p>Related content</p>
    </Card>,
  );
  expect(screen.getByRole('article', { name: 'Summary' })).toContainElement(
    screen.getByText('Related content'),
  );
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
    'Summary',
  );
  expect(screen.getByRole('button', { name: 'Review' })).toBeEnabled();
  expect(screen.getByText('Details')).toBeVisible();
});
test('CardHeader supports a bounded heading level', () => {
  render(<CardHeader title="Subgroup" level={3} />);
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(
    'Subgroup',
  );
});
