import { describe, expect, it } from 'vitest';
import { easiestFirstIds, hardestFirst } from './difficulty';

describe('difficulty order', () => {
  it('shows levels hardest first without changing the input, and maps ids back', () => {
    const levels = [{ id: 'easy' }, { id: 'normal' }, { id: 'hard' }];
    expect(hardestFirst(levels).map((level) => level.id)).toEqual(['hard', 'normal', 'easy']);
    expect(levels.map((level) => level.id)).toEqual(['easy', 'normal', 'hard']);
    expect(easiestFirstIds(['hard', 'easy', 'normal'])).toEqual(['normal', 'easy', 'hard']);
  });
});
