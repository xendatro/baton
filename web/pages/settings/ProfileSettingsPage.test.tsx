import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, mockApi, testConfig, testMe } from '@web/test/mockApi';
import type { UsernameCheck } from '@web/components/auth/useUsernameAvailability';
import ProfileSettingsPage from './ProfileSettingsPage';
import { jsonBody, renderSettingsPage } from './testing';

const LAZY = { timeout: 5000 };

// Better Auth's client keeps its own fetch; the availability check is replaced instead.
const availability = vi.hoisted(() => ({
  taken: new Set<string>(),
  calls: [] as string[],
}));

vi.mock('@web/components/auth/useUsernameAvailability', () => ({
  useUsernameAvailability: (username: string): UsernameCheck => {
    const value = username.trim().toLowerCase();
    if (!value) return { status: 'idle', message: null };
    availability.calls.push(value);
    return availability.taken.has(value)
      ? { status: 'taken', message: `@${value} is taken` }
      : { status: 'available', message: `@${value} is available` };
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  availability.taken.clear();
  availability.calls = [];
});

describe('profile settings', () => {
  it('saves the display name', async () => {
    const fetchMock = mockApi({
      'GET /api/me': testMe(),
      'GET /api/config': testConfig,
      'PATCH /api/me': ({ init }: { init?: RequestInit }) =>
        jsonResponse({ ...testMe().user, ...(jsonBody(init) as object) }),
    });
    const user = userEvent.setup();
    renderSettingsPage(<ProfileSettingsPage />);
    await screen.findByRole('heading', { name: 'Profile' }, LAZY);
    const nameForm = await screen.findByRole('form', { name: 'Display name' }, LAZY);
    const save = within(nameForm).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const input = within(nameForm).getByLabelText('Name');
    await user.clear(input);
    await user.type(input, 'Ada King');
    await user.click(save);
    expect(await screen.findByText('Display name saved')).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(jsonBody(patch?.[1])).toEqual({ name: 'Ada King' });
  });

  it('checks username availability live, but not for the current username', async () => {
    mockApi({ 'GET /api/me': testMe(), 'GET /api/config': testConfig });
    availability.taken.add('grace');
    const user = userEvent.setup();
    renderSettingsPage(<ProfileSettingsPage />);
    const usernameForm = await screen.findByRole('form', { name: 'Username' }, LAZY);
    const input = within(usernameForm).getByLabelText('Username');
    expect(input).toHaveValue('ada');
    expect(within(usernameForm).getByRole('button', { name: 'Change username' })).toBeDisabled();
    expect(availability.calls).toEqual([]);

    await user.clear(input);
    await user.type(input, 'grace');
    expect(await within(usernameForm).findByText('@grace is taken', {}, LAZY)).toBeInTheDocument();
    expect(within(usernameForm).getByRole('note')).toHaveTextContent(
      'Existing mentions of @ada will stop pointing at you',
    );

    await user.clear(input);
    await user.type(input, 'ada_lovelace');
    expect(
      await within(usernameForm).findByText('@ada_lovelace is available', {}, LAZY),
    ).toBeInTheDocument();
  });

  it('shows a server conflict next to the username', async () => {
    mockApi({
      'GET /api/me': testMe(),
      'GET /api/config': testConfig,
      'PATCH /api/me': () =>
        jsonResponse(
          {
            error: {
              code: 'conflict',
              message: '@grace is taken',
              details: { issues: [{ path: 'username', message: '@grace is taken' }] },
            },
          },
          409,
        ),
    });
    const user = userEvent.setup();
    renderSettingsPage(<ProfileSettingsPage />);
    const usernameForm = await screen.findByRole('form', { name: 'Username' }, LAZY);
    const input = within(usernameForm).getByLabelText('Username');
    await user.clear(input);
    await user.type(input, 'grace');
    await within(usernameForm).findByText('@grace is available', {}, LAZY);
    await user.click(within(usernameForm).getByRole('button', { name: 'Change username' }));
    expect(await within(usernameForm).findByRole('alert')).toHaveTextContent('@grace is taken');
  });

  it('uploads and removes the profile picture', async () => {
    const withImage = { ...testMe().user, image: '/api/attachments/a1/me.png' };
    const fetchMock = mockApi({
      'GET /api/me': testMe({ image: '/api/attachments/a0/old.png' }),
      'GET /api/config': testConfig,
      'DELETE /api/me/avatar': { ...withImage, image: null },
    });
    const xhrSend = vi.fn();
    class FakeXhr {
      status = 200;
      responseText = JSON.stringify(withImage);
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open = vi.fn();
      setRequestHeader = vi.fn();
      withCredentials = false;
      addEventListener(type: string, listener: () => void) {
        this.listeners.set(type, listener);
      }
      send(body: FormData) {
        xhrSend(body);
        queueMicrotask(() => this.listeners.get('load')?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() }),
    );
    const user = userEvent.setup();
    renderSettingsPage(<ProfileSettingsPage />);

    await screen.findByRole('button', { name: 'Upload new picture' }, LAZY);
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Choose a profile picture'), file);
    expect(await screen.findByText('Profile picture updated')).toBeInTheDocument();
    expect(xhrSend).toHaveBeenCalledOnce();
    expect((xhrSend.mock.calls[0]?.[0] as FormData).get('file')).toBeInstanceOf(File);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Profile picture removed')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });

  it('refuses files that are not images before uploading', async () => {
    mockApi({ 'GET /api/me': testMe(), 'GET /api/config': testConfig });
    const xhr = vi.fn();
    vi.stubGlobal('XMLHttpRequest', xhr);
    const user = userEvent.setup({ applyAccept: false });
    renderSettingsPage(<ProfileSettingsPage />);
    await screen.findByRole('button', { name: 'Upload picture' }, LAZY);
    const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    await user.upload(screen.getByLabelText('Choose a profile picture'), file);
    expect(await screen.findByText('Use a PNG, JPEG, GIF or WebP image.')).toBeInTheDocument();
    expect(xhr).not.toHaveBeenCalled();
  });

  it('shows an error state with a retry when the profile can’t load', async () => {
    mockApi({
      'GET /api/me': () => jsonResponse({ error: { code: 'forbidden', message: 'Boom' } }, 403),
      'GET /api/config': testConfig,
    });
    renderSettingsPage(<ProfileSettingsPage />);
    expect(await screen.findByText('Boom', {}, LAZY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
