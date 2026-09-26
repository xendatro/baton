import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { contrastRatio, MIN_TEXT_CONTRAST } from '@web/lib/colors';
import { DueDate } from './DueDate';

/** `YYYY-MM-DD` of today in local time, as the due-date helpers read it. */
function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

describe('DueDate', () => {
  it('shows "Today" in a light-mode amber that reaches AA on white (UX-12)', () => {
    render(<DueDate value={today()} />);
    const label = screen.getByText('Today').parentElement;
    // amber-600 (#e17100) was 3.2:1 on white; amber-700 is 5.1:1.
    expect(label).toHaveClass('text-amber-700');
    expect(label).not.toHaveClass('text-amber-600');
    expect(contrastRatio('#bb4d00', '#ffffff')).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});
