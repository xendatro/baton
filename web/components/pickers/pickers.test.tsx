import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DatePicker } from './DatePicker';
import { DifficultyPicker } from './DifficultyPicker';
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

describe('DifficultyPicker', () => {
  it('lists the levels hardest first, then "No difficulty"', () => {
    render(
      <DifficultyPicker
        levels={[
          { id: 'e', name: 'Easy', color: '#22c55e' },
          { id: 'h', name: 'Hard', color: '#ef4444' },
        ]}
        value={null}
        onChange={() => undefined}
        open
      />,
    );
    expect(screen.getByText('Hardest → easiest')).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Hard',
      'Easy',
      expect.stringMatching(/^No difficulty/),
    ]);
  });
});
