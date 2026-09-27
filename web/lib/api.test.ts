import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  api,
  ApiError,
  buildUrl,
  configureApi,
  errorFromResponse,
  isAuthRoutingError,
  loginPath,
} from './api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorBody(code: string, message = 'Nope') {
  return { error: { code, message } };
}

const navigate = vi.fn<(to: string) => void>();
const onUnauthorized = vi.fn();
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  navigate.mockReset();
  onUnauthorized.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  configureApi({ navigate, onUnauthorized });
  window.history.replaceState(null, '', '/t/acme/p/WEB/tasks?status=open');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requests', () => {
  it('sends JSON with credentials and validates the response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { count: 3 }));
    const result = await api.post(
      '/api/things',
      { a: 1 },
      { schema: z.object({ count: z.number() }) },
    );
    expect(result).toEqual({ count: 3 });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/things');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{"a":1}' });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('rejects responses that break the contract', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { count: 'three' }));
    await expect(
      api.get('/api/x', { schema: z.object({ count: z.number() }) }),
    ).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('builds query strings, dropping empty values and joining arrays', () => {
    expect(
      buildUrl('/api/search', {
        q: 'fix bug',
        types: ['task', 'issue'],
        limit: 5,
        x: undefined,
        y: '',
      }),
    ).toBe('/api/search?q=fix+bug&types=task%2Cissue&limit=5');
    expect(buildUrl('/api/x')).toBe('/api/x');
  });
});

describe('errors', () => {
  it('parses the error envelope into an ApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'validation_failed',
          message: 'Invalid input',
          details: { issues: [{ path: ['title'], message: 'Required' }] },
        },
      }),
    );
    const error = await api.post('/api/tasks', {}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'validation_failed',
      status: 400,
      message: 'Invalid input',
    });
    expect((error as ApiError).fieldErrors).toEqual({ title: 'Required' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('maps non-JSON failures by status', () => {
    expect(errorFromResponse(502, '<html>Bad gateway</html>')).toMatchObject({
      code: 'internal',
      status: 502,
    });
    expect(errorFromResponse(413, undefined).code).toBe('payload_too_large');
    expect(errorFromResponse(429, undefined).code).toBe('rate_limited');
    expect(errorFromResponse(423, undefined).code).toBe('agents_paused');
  });

  it('keeps the server’s message for paused agents', () => {
    const message = 'Ethan AI is paused. Its API keys can read but not write.';
    expect(errorFromResponse(423, { error: { code: 'agents_paused', message } })).toMatchObject({
      code: 'agents_paused',
      status: 423,
      message,
    });
  });

  it('reports network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.get('/api/me')).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });
});

describe('auth error routing', () => {
  it('sends 401s to the login page with the current path as next', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, errorBody('unauthorized')));
    const error = await api.get('/api/me').catch((cause: unknown) => cause);
    expect(isAuthRoutingError(error)).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent('/t/acme/p/WEB/tasks?status=open')}`,
    );
  });

  it('sends unverified users to /verify-email', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, errorBody('email_not_verified')));
    await api.get('/api/teams').catch(() => undefined);
    expect(navigate).toHaveBeenCalledWith(
      `/verify-email?next=${encodeURIComponent('/t/acme/p/WEB/tasks?status=open')}`,
    );
  });

  it('sends users without a username to onboarding', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, errorBody('username_required')));
    await api.get('/api/teams').catch(() => undefined);
    expect(navigate).toHaveBeenCalledWith(
      `/onboarding/username?next=${encodeURIComponent('/t/acme/p/WEB/tasks?status=open')}`,
    );
  });

  it('does not route plain 403s, opted-out requests or requests from auth pages', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(403, errorBody('forbidden'))));
    await api.get('/api/teams').catch(() => undefined);
    expect(navigate).not.toHaveBeenCalled();

    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(401, errorBody('unauthorized'))),
    );
    await api.get('/api/me', { routeAuthErrors: false }).catch(() => undefined);
    expect(navigate).not.toHaveBeenCalled();

    window.history.replaceState(null, '', '/login');
    await api.get('/api/me').catch(() => undefined);
    expect(navigate).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('omits next for the dashboard', () => {
    expect(loginPath('/')).toBe('/login');
    expect(loginPath('/inbox')).toBe('/login?next=%2Finbox');
  });
});
