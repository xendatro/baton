/**
 * A small user-agent reader for the sessions list and the security log ("Chrome on macOS"). It
 * recognises the browsers and systems people actually sign in with and says "Unknown" otherwise;
 * it is a display aid, never a security signal.
 */

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export interface ParsedUserAgent {
  /** Browser family, e.g. "Chrome", "Firefox"; null when unrecognised. */
  browser: string | null;
  /** Operating system, e.g. "macOS", "Windows", "iOS"; null when unrecognised. */
  os: string | null;
  device: DeviceType;
}

/** Checked in order: several browsers also claim to be Chrome or Safari. */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bYaBrowser\//, 'Yandex Browser'],
  [/\bBrave\//, 'Brave'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  [/\bPlaywright\b|\bHeadlessChrome\//, 'Headless Chrome'],
  [/^curl\//, 'curl'],
  [/^node(?:-fetch)?\b|\bundici\b/i, 'Node.js'],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\biPad\b/, 'iPadOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  const ua = (userAgent ?? '').slice(0, 512);
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const tablet =
    /\biPad\b|\bTablet\b/.test(ua) || (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua));
  const mobile = !tablet && /\bMobi|\biPhone\b|\biPod\b/.test(ua);
  return { browser, os, device: tablet ? 'tablet' : mobile ? 'mobile' : 'desktop' };
}

/** "Chrome on macOS", "Firefox", "Unknown device". */
export function describeUserAgent(userAgent: string | null | undefined): string {
  const { browser, os } = parseUserAgent(userAgent);
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}
