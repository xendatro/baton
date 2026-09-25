import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoredTheme } from '@web/lib/theme';
import { jsonResponse, mockApi, testMe, testSession } from '@web/test/mockApi';
import AccountShellExtension from './AccountShellExtension';
import AppearanceSettingsPage from './AppearanceSettingsPage';
import { jsonBody, renderSettingsPage, requestUrl } from './testing';

const LAZY = { timeout: 5000 };

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function withExtension() {
  return (
    <>
      <AccountShellExtension />
      <AppearanceSettingsPage />
    </>
  );
}

describe('appearance settings', () => {
  it('applies a theme at once and saves it to the profile', async () => {
    localStorage.setItem('baton-theme-session', testSession.session.id);
    const fetchMock = mockApi({
      'GET /api/auth/get-session': testSession,
      'GET /api/me': testMe(),
      'PATCH /api/me': ({ init }: { init?: RequestInit }) =>
        jsonResponse({ ...testMe().user, ...(jsonBody(init) as object) }),
    });
    const user = userEvent.setup();
    renderSettingsPage(withExtension());
    const dark = await screen.findByRole('radio', { name: /Dark/ }, LAZY);
    expect(screen.getByRole('radio', { name: /System/ })).toBeChecked();

    await user.click(dark);
    expect(dark).toBeChecked();
    expect(document.documentElement).toHaveClass('dark');
    expect(getStoredTheme()).toBe('dark');
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            requestUrl(url) === '/api/me' &&
            init?.method === 'PATCH' &&
            JSON.stringify(jsonBody(init)) === '{"theme":"dark"}',
        ),
      ).toBe(true),
    );
  });

  it('adopts the profile theme on a new sign-in, but not on later loads', async () => {
    localStorage.setItem('baton-theme', 'light');
    mockApi({
      'GET /api/auth/get-session': testSession,
      'GET /api/me': testMe({ theme: 'dark' }),
    });
    const first = renderSettingsPage(withExtension());
    await waitFor(() => expect(getStoredTheme()).toBe('dark'));
    expect(localStorage.getItem('baton-theme-session')).toBe(testSession.session.id);
    first.unmount();

    // Same session, local choice changed since: the local choice stays.
    localStorage.setItem('baton-theme', 'light');
    renderSettingsPage(withExtension());
    await screen.findByRole('radio', { name: /Light/ }, LAZY);
    expect(getStoredTheme()).toBe('light');
  });

  it('never adopts the profile theme over a choice made before the profile loaded', async () => {
    let releaseMe: () => void = () => undefined;
    const meLoaded = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    mockApi({
      'GET /api/auth/get-session': testSession,
      'GET /api/me': () => jsonResponse(testMe({ theme: 'system' })),
      'PATCH /api/me': () => jsonResponse(testMe({ theme: 'dark' }).user),
    });
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (requestUrl(input) === '/api/me' && (init?.method ?? 'GET') === 'GET') await meLoaded;
      return original ? original(input, init) : new Response(null, { status: 500 });
    });
    const user = userEvent.setup();
    renderSettingsPage(withExtension());
    await user.click(await screen.findByRole('radio', { name: /Dark/ }, LAZY));
    releaseMe();
    await waitFor(() => expect(localStorage.getItem('baton-theme-session')).toBe('s1'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getStoredTheme()).toBe('dark');
  });
});
