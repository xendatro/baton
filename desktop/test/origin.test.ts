import { describe, expect, it } from 'vitest';
import { isAllowedSender, navigationTarget } from '../src/main/origin';

describe('who may use the desktop bridge', () => {
  const server = 'https://www.passthebaton.dev';

  it('only the Baton server’s own origin', () => {
    expect(isAllowedSender('https://www.passthebaton.dev/desktop', server)).toBe(true);
    expect(isAllowedSender('https://passthebaton.dev/desktop', server)).toBe(false);
    expect(isAllowedSender('http://www.passthebaton.dev/', server)).toBe(false);
    expect(isAllowedSender('https://evil.example/https://www.passthebaton.dev', server)).toBe(
      false,
    );
    expect(isAllowedSender('file:///tmp/offline.html', server)).toBe(false);
    expect(isAllowedSender(undefined, server)).toBe(false);
  });

  it('keeps the server and sign-in in the app; the rest opens in the browser', () => {
    expect(navigationTarget('https://www.passthebaton.dev/t/baton', server)).toBe('app');
    expect(navigationTarget('https://accounts.google.com/o/oauth2/v2/auth?x=1', server)).toBe(
      'app',
    );
    expect(navigationTarget('https://github.com/login/oauth/authorize?x=1', server)).toBe('app');
    expect(navigationTarget('https://github.com/xendatro/baton', server)).toBe('browser');
    expect(navigationTarget('https://example.com', server)).toBe('browser');
    expect(navigationTarget('javascript:alert(1)', server)).toBe('browser');
  });
});
