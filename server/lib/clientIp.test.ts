import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIp } from './clientIp';

/** Which header the client's address comes from, per `TRUST_PROXY`. */
describe('clientIp', () => {
  const app = (mode: 'cloudflare' | 'render') =>
    new Hono().get('/', (c) => c.text(clientIp(c, mode) ?? 'none'));
  const ip = async (mode: 'cloudflare' | 'render', headers: Record<string, string>) =>
    (await app(mode).request('/', { headers })).text();

  it('uses CF-Connecting-IP behind Cloudflare Tunnel', async () => {
    expect(await ip('cloudflare', { 'CF-Connecting-IP': '203.0.113.7' })).toBe('203.0.113.7');
    expect(await ip('cloudflare', {})).toBe('none');
  });

  it('uses the address Render’s proxy appended, not ones the client sent', async () => {
    expect(await ip('render', { 'X-Forwarded-For': '203.0.113.7' })).toBe('203.0.113.7');
    // A client forging the header can't choose the last entry, which Render appends.
    expect(await ip('render', { 'X-Forwarded-For': '10.0.0.1, 198.51.100.2' })).toBe(
      '198.51.100.2',
    );
    expect(await ip('render', {})).toBe('none');
  });
});
