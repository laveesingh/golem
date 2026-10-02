import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { Button } from '../../dashboard/web/src/ui/atoms/Button.tsx';

describe('Button native behavior', () => {
  test('decorative static cue slot is present before and during busy without changing name', () => {
    const view = render(<Button label="Create" />),
      button = screen.getByRole('button', { name: 'Create' }),
      cue = button.querySelector('[data-busy-indicator]');
    view.rerender(<Button label="Create" busy />);
    expect(button.querySelector('[data-busy-indicator]')).toBe(cue);
    expect(button).toHaveAccessibleName('Create');
    expect(cue).toHaveAttribute('aria-hidden', 'true');
  });
  test('default primary native button avoids implicit form submission', async () => {
    const submit = vi.fn(),
      click = vi.fn();
    render(
      <form onSubmit={submit}>
        <Button label="Create" onClick={click} />
      </form>,
    );
    const button = screen.getByRole('button', { name: 'Create' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'primary');
    await userEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });
  test('Enter and Space use native activation', async () => {
    const click = vi.fn();
    render(<Button label="Create" onClick={click} />);
    await userEvent.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await userEvent.keyboard('{Enter} ');
    expect(click).toHaveBeenCalledTimes(2);
  });
  test('busy retains label/focus and prevents pointer/keyboard/submission duplicates', async () => {
    const click = vi.fn(),
      submit = vi.fn();
    const view = render(
      <form onSubmit={submit}>
        <Button label="Create" type="submit" onClick={click} />
      </form>,
    );
    await userEvent.tab();
    const button = screen.getByRole('button');
    view.rerender(
      <form onSubmit={submit}>
        <Button label="Create" type="submit" busy onClick={click} />
      </form>,
    );
    expect(button).toHaveFocus();
    expect(button).toHaveTextContent('Create');
    expect(button).toHaveAccessibleName('Create');
    expect(button.querySelector('[data-busy-indicator]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    await userEvent.keyboard('{Enter} ');
    expect(click).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  test('native disabled wins over busy, no focus or activation', async () => {
    const click = vi.fn();
    render(<Button label="Create" busy disabled onClick={click} />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute('aria-busy');
    await userEvent.tab();
    expect(button).not.toHaveFocus();
    await userEvent.click(button);
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });
  test('quiet and long text remain visible; blank label fails', () => {
    render(
      <Button
        label="An extremely long descriptive action label"
        variant="quiet"
      />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'quiet');
    expect(() => render(<Button label=" " />)).toThrow(/nonempty/);
  });
});
