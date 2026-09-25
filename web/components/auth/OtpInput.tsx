import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { OTP } from '@shared/constants';
import { cn } from '@web/lib/utils';

export interface OtpInputProps {
  /** Called with the digits typed so far (empty positions are skipped). */
  onChange?: (code: string) => void;
  /** Called once every box is filled (auto-submit). */
  onComplete?: (code: string) => void;
  length?: number;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  /** Accessible name of the group. */
  label?: string;
  /** Id of an element describing the input (e.g. an error message). */
  describedBy?: string;
}

/**
 * One box per digit of an emailed code. Typing advances, Backspace goes back, arrow keys move,
 * and pasting (or the browser's one-time-code autofill) spreads the digits across the boxes.
 * Remount it (change its `key`) to clear it.
 */
export function OtpInput({
  onChange,
  onComplete,
  length = OTP.length,
  disabled = false,
  invalid = false,
  autoFocus = false,
  label = 'Verification code',
  describedBy,
}: OtpInputProps) {
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length }, () => ''));
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const focus = (index: number) => {
    const target = inputs.current[Math.max(0, Math.min(length - 1, index))];
    target?.focus();
    target?.select();
  };

  const commit = (next: string[]) => {
    setDigits(next);
    const code = next.join('');
    onChange?.(code);
    if (next.every((digit) => digit !== '')) onComplete?.(code);
  };

  /** Writes digits starting at `start`; returns the index after the last one written. */
  const fill = (start: number, text: string): number => {
    const incoming = text
      .replace(/\D/g, '')
      .slice(0, length - start)
      .split('');
    if (incoming.length === 0) return start;
    const next = [...digits];
    incoming.forEach((digit, offset) => {
      next[start + offset] = digit;
    });
    commit(next);
    return start + incoming.length;
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const next = [...digits];
      if (next[index]) {
        next[index] = '';
        commit(next);
      } else if (index > 0) {
        next[index - 1] = '';
        commit(next);
        focus(index - 1);
      }
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const next = [...digits];
      next[index] = '';
      commit(next);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focus(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focus(index + 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focus(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focus(length - 1);
    }
  };

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const end = fill(index, event.clipboardData.getData('text'));
    focus(end >= length ? length - 1 : end);
  };

  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className="flex justify-center gap-2"
    >
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => {
            inputs.current[index] = element;
          }}
          value={digit}
          onChange={(event) => {
            const text = event.target.value;
            if (text === '') {
              const next = [...digits];
              next[index] = '';
              commit(next);
              return;
            }
            // A new digit replaces the box's content; autofill may deliver the whole code.
            const typed = text.length > 1 && digit !== '' ? text.replace(digit, '') : text;
            const end = fill(index, typed);
            if (end > index) focus(end >= length ? length - 1 : end);
          }}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={(event) => onPaste(index, event)}
          onFocus={(event) => event.target.select()}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          pattern="[0-9]*"
          maxLength={length}
          disabled={disabled}
          autoFocus={autoFocus && index === 0}
          aria-label={`Digit ${index + 1} of ${length}`}
          aria-invalid={invalid || undefined}
          className={cn(
            'size-11 rounded-md border border-input bg-transparent text-center font-mono text-lg font-semibold shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 sm:size-12 dark:bg-input/30',
          )}
        />
      ))}
    </div>
  );
}
