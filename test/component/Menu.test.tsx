import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { Menu } from '../../dashboard/web/src/ui/molecules/Menu.tsx';

function items(fn: () => void) {
  return [
    { id: 'one', label: 'First', onSelect: fn },
    { id: 'none', label: 'Disabled', disabled: true, onSelect: fn },
    { id: 'last', label: 'Last', onSelect: fn },
  ];
}
test('Menu opens, roves across enabled actions, selects once and returns focus', async () => {
  const fn = vi.fn(),
    user = userEvent.setup();
  render(<Menu label="Actions" items={items(fn)} />);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  await user.tab();
  await user.keyboard('{ArrowDown}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();
  await user.keyboard('{Home}{End}{Enter}');
  expect(fn).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(trigger).toHaveFocus();
});
test('Escape restores focus, Tab exits and outside pointer dismisses', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Menu label="Actions" items={items(vi.fn())} />
      <button type="button">Outside</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'Actions' });
  await user.click(trigger);
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.tab();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByRole('menu')).toBeNull();
});
test('ArrowUp starts last, typeahead wraps and disabled actions do not activate', async () => {
  const fn = vi.fn(),
    user = userEvent.setup();
  render(<Menu label="Actions" items={items(fn)} />);
  screen.getByRole('button').focus();
  await user.keyboard('{ArrowUp}');
  expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus();
  await user.keyboard('f');
  expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
  await user.click(screen.getByRole('menuitem', { name: 'Disabled' }));
  expect(fn).not.toHaveBeenCalled();
});
test('disabled trigger and all-disabled panel have explicit behavior', async () => {
  const user = userEvent.setup(),
    fn = vi.fn();
  const { rerender } = render(
    <Menu label="Actions" disabled items={items(fn)} />,
  );
  await user.click(screen.getByRole('button'));
  expect(screen.queryByRole('menu')).toBeNull();
  rerender(
    <Menu
      label="Actions"
      items={[{ id: 'none', label: 'None', disabled: true, onSelect: fn }]}
    />,
  );
  await user.click(screen.getByRole('button'));
  expect(screen.getByRole('menu')).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button')).toHaveFocus();
});
