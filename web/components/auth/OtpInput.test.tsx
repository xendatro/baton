import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OtpInput } from './OtpInput';

function boxes(): HTMLInputElement[] {
  return screen.getAllByRole<HTMLInputElement>('textbox');
}

describe('OtpInput', () => {
  it('renders six labelled boxes', () => {
    render(<OtpInput />);
    expect(boxes()).toHaveLength(6);
    expect(screen.getByRole('group', { name: 'Verification code' })).toBeInTheDocument();
    expect(screen.getByLabelText('Digit 1 of 6')).toHaveAttribute('autocomplete', 'one-time-code');
  });

  it('advances as digits are typed and auto-submits when complete', async () => {
    const onComplete = vi.fn();
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<OtpInput onComplete={onComplete} onChange={onChange} autoFocus />);
    await user.keyboard('12345');
    expect(boxes()[5]).toHaveFocus();
    expect(onComplete).not.toHaveBeenCalled();
    await user.keyboard('6');
    expect(onComplete).toHaveBeenCalledWith('123456');
    expect(onChange).toHaveBeenLastCalledWith('123456');
  });

  it('ignores non-digits', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<OtpInput onChange={onChange} autoFocus />);
    await user.keyboard('a');
    expect(boxes()[0]).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves back and clears with Backspace', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<OtpInput onChange={onChange} autoFocus />);
    await user.keyboard('12');
    expect(boxes()[2]).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(boxes()[1]).toHaveFocus();
    expect(boxes()[1]).toHaveValue('');
    expect(onChange).toHaveBeenLastCalledWith('1');
  });

  it('spreads a pasted code across the boxes and completes', () => {
    const onComplete = vi.fn();
    render(<OtpInput onComplete={onComplete} />);
    fireEvent.paste(boxes()[0]!, { clipboardData: { getData: () => ' 123-456 ' } });
    expect(boxes().map((box) => box.value)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(onComplete).toHaveBeenCalledWith('123456');
  });

  it('accepts a whole code delivered by one-time-code autofill', () => {
    const onComplete = vi.fn();
    render(<OtpInput onComplete={onComplete} />);
    fireEvent.change(boxes()[0]!, { target: { value: '654321' } });
    expect(onComplete).toHaveBeenCalledWith('654321');
  });

  it('marks the boxes invalid', () => {
    render(<OtpInput invalid />);
    for (const box of boxes()) expect(box).toHaveAttribute('aria-invalid', 'true');
  });
});
