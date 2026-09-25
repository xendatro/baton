import { vi } from 'vitest';
import type { MeResponse } from '@shared/schemas/core';

/**
 * Test doubles for the browser's network APIs: `mockApi` answers `fetch` from a route table
 * (unknown routes get a JSON 404) and `FakeEventSource` stands in for the SSE connection.
 */

/** A JSON body to return, or a function building the response. */
export type MockRoute = unknown;
type RouteHandler = (request: { url: URL; init?: RequestInit }) => Response;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stubs `fetch` and `EventSource`; call `vi.unstubAllGlobals()` in `afterEach`. */
export function mockApi(routes: Record<string, MockRoute>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`] ?? routes[url.pathname];
    if (route === undefined) {
      return Promise.resolve(
        jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404),
      );
    }
    return Promise.resolve(
      typeof route === 'function'
        ? (route as RouteHandler)({ url, init })
        : jsonResponse(route),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);
  return fetchMock;
}

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  /** `closed: true` simulates the browser giving up (HTTP error); false a network blip. */
  fail(closed: boolean): void {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event('error'));
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

export const testSession = {
  session: { id: 's1', expiresAt: '2099-01-01T00:00:00.000Z' },
  user: { id: 'u1', email: 'ada@example.com', emailVerified: true, name: 'Ada', username: 'ada' },
};

export function testMe(overrides: Partial<MeResponse['user']> = {}): MeResponse {
  return {
    user: {
      id: 'u1',
      email: 'ada@example.com',
      emailVerified: true,
      username: 'ada',
      displayUsername: 'ada',
      name: 'Ada Lovelace',
      image: null,
      theme: 'system',
      ...overrides,
    },
    teams: [
      {
        id: 't1',
        slug: 'acme',
        name: 'Acme',
        icon: null,
        color: '#6366f1',
        isOwner: true,
        permissions: ['ADMINISTRATOR'],
        projects: [{ id: 'p1', key: 'WEB', name: 'Web app', icon: null, color: '#0ea5e9' }],
      },
    ],
    unreadNotifications: 2,
  };
}

export const testConfig = {
  version: 'test',
  signupsEnabled: true,
  providers: { google: false, github: true },
  maxUploadMb: 25,
};
