import { describe, expect, it } from 'vitest';
import { firstName, greeting, parseInviteInput } from './invite';

describe('parseInviteInput', () => {
  it('accepts a code, a full link or its path', () => {
    expect(parseInviteInput(' AbCd123456 ')).toBe('AbCd123456');
    expect(parseInviteInput('https://baton.example/join/AbCd123456')).toBe('AbCd123456');
    expect(parseInviteInput('http://localhost:5173/join/AbCd123456?utm=x')).toBe('AbCd123456');
    expect(parseInviteInput('/join/AbCd123456/')).toBe('AbCd123456');
    expect(parseInviteInput('join/AbCd123456')).toBe('AbCd123456');
  });

  it('refuses anything else', () => {
    for (const input of [
      '',
      '   ',
      'AbCd12345',
      'AbCd1234567',
      'https://x/join/AbCd12-456',
      'https://x/t/acme',
    ]) {
      expect(parseInviteInput(input), input).toBeNull();
    }
  });
});

describe('greeting', () => {
  it('follows the time of day', () => {
    const at = (hour: number) => new Date(2026, 2, 10, hour, 30);
    expect(greeting(at(8))).toBe('Good morning');
    expect(greeting(at(13))).toBe('Good afternoon');
    expect(greeting(at(20))).toBe('Good evening');
    expect(greeting(at(2))).toBe('Good evening');
  });

  it('uses the first word of the name', () => {
    expect(firstName('  Ada Lovelace ')).toBe('Ada');
    expect(firstName('Mononym')).toBe('Mononym');
  });
});
