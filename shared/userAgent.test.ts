import { describe, expect, it } from 'vitest';
import { describeUserAgent, parseUserAgent } from './userAgent';

const AGENTS = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIpad:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
};

describe('parseUserAgent', () => {
  it.each([
    [AGENTS.chromeMac, 'Chrome', 'macOS', 'desktop'],
    [AGENTS.edgeWindows, 'Edge', 'Windows', 'desktop'],
    [AGENTS.firefoxLinux, 'Firefox', 'Linux', 'desktop'],
    [AGENTS.safariIphone, 'Safari', 'iOS', 'mobile'],
    [AGENTS.chromeIpad, 'Chrome', 'iPadOS', 'tablet'],
    [AGENTS.androidPhone, 'Chrome', 'Android', 'mobile'],
    [AGENTS.androidTablet, 'Chrome', 'Android', 'tablet'],
    [AGENTS.samsung, 'Samsung Internet', 'Android', 'mobile'],
    ['curl/8.5.0', 'curl', null, 'desktop'],
  ])('reads %s', (agent, browser, os, device) => {
    expect(parseUserAgent(agent)).toEqual({ browser, os, device });
  });

  it('copes with missing or unknown agents', () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, device: 'desktop' });
    expect(describeUserAgent('')).toBe('Unknown device');
    expect(describeUserAgent(AGENTS.chromeMac)).toBe('Chrome on macOS');
    expect(describeUserAgent('curl/8.5.0')).toBe('curl');
  });
});
