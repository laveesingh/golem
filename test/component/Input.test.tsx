import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { Input } from '../../dashboard/web/src/ui/atoms/Input.tsx';

test('visible label names input, placeholder not name, uncontrolled edits emit native events', async () => {
  const change = vi.fn();
  render(
    <Input
      id="title"
      label="Item title"
      placeholder="Enter title"
      defaultValue="A"
      onChange={change}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Item title' });
  expect(input).toHaveAttribute('id', 'title');
  await userEvent.type(input, 'B');
  expect(input).toHaveValue('AB');
  expect(change).toHaveBeenCalledTimes(1);
});
test('controlled value contract updates through onChange', async () => {
  function Field() {
    const [value, setValue] = useState('');
    return (
      <Input
        id="controlled"
        label="Controlled title"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  }
  render(<Field />);
  await userEvent.type(screen.getByRole('textbox'), 'new');
  expect(screen.getByRole('textbox')).toHaveValue('new');
});
test('error owns invalid/describedby, readable primary-text sentence, supplied description retained', () => {
  render(
    <>
      <p id="hint">A clear title</p>
      <Input
        id="title"
        label="Item title"
        required
        error="Enter a title"
        describedBy="hint"
      />
    </>,
  );
  const input = screen.getByRole('textbox', { name: 'Item title (required)' });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAttribute('aria-describedby', 'hint title-error');
  expect(input).toHaveAccessibleDescription('A clear title Enter a title');
});
test('read-only remains focusable and unchanged; disabled cannot edit or tab', async () => {
  render(
    <>
      <Input id="ro" label="Read-only title" defaultValue="Original" readOnly />
      <Input
        id="disabled"
        label="Disabled title"
        defaultValue="Disabled"
        disabled
      />
    </>,
  );
  await userEvent.tab();
  const ro = screen.getByRole('textbox', { name: 'Read-only title' });
  expect(ro).toHaveFocus();
  await userEvent.type(ro, 'X');
  expect(ro).toHaveValue('Original');
  await userEvent.tab();
  expect(
    screen.getByRole('textbox', { name: 'Disabled title' }),
  ).not.toHaveFocus();
});
test('label and deterministic caller id are required', () => {
  expect(() => render(<Input id="" label="Title" />)).toThrow(/id/);
  expect(() => render(<Input id="title" label=" " />)).toThrow(/label/);
});
