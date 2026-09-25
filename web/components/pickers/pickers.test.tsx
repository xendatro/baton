import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DatePicker } from './DatePicker';
import { PriorityPicker } from './PriorityPicker';

// Regression (WEB-15): the triggers were announced as just "High" or "Sep 28".
describe('picker triggers', () => {
  it('name the property they set', () => {
    render(
      <>
        <PriorityPicker value={3} onChange={() => undefined} />
        <DatePicker value="2026-09-28" onChange={() => undefined} />
        <DatePicker value={null} onChange={() => undefined} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Priority: High' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Due date: / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set due date' })).toBeInTheDocument();
  });
});
