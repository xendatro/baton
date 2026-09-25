import { describe, expect, it } from 'vitest';
import { commandFilter } from './commandFilter';

const ULID = '01K5ZQ8M3XDEFB7C2HNRTW9PAG';

describe('commandFilter', () => {
  // Regression (WEB-6): "sign out" matched "Settings" (its id and keywords) and ran it on Enter.
  it('drops scattered-letter matches and keeps real ones', () => {
    expect(commandFilter('nav.settings', 'sign out', ['Settings', 'account', 'profile'])).toBe(0);
    expect(commandFilter('account.sign-out', 'sign out', ['Sign out', 'log out'])).toBeGreaterThan(
      0.9,
    );
    expect(commandFilter('nav.settings', 'prof', ['Settings', 'profile'])).toBeGreaterThan(0.5);
  });

  // Regression (WEB-7): ids in item values made unrelated labels match short queries.
  it('never scores the id', () => {
    for (const query of ['fe', 'bc', 'ap']) {
      expect(commandFilter(ULID, query, ['Bug'])).toBe(0);
      expect(commandFilter(ULID, query, ['Done'])).toBe(0);
    }
    expect(commandFilter(ULID, 'fe', ['Feature'])).toBeGreaterThan(0.9);
  });
});
