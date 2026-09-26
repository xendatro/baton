import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chordLabels,
  hotkeyLabels,
  isTypingTarget,
  parseChord,
  registerHotkey,
  SEQUENCE_TIMEOUT_MS,
  useHotkey,
  useRegisteredHotkeys,
} from './hotkeys';

const cleanups: Array<() => void> = [];

function register(keys: string, description = keys, options = {}) {
  const handler = vi.fn();
  cleanups.push(registerHotkey(keys, handler, { description, ...options }));
  return handler;
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('parsing and labels', () => {
  it('parses modifiers and aliases', () => {
    expect(parseChord('mod+k')).toEqual({ key: 'k', mod: true, shift: false, alt: false });
    expect(parseChord('shift+Enter')).toEqual({
      key: 'enter',
      mod: false,
      shift: true,
      alt: false,
    });
    expect(parseChord('esc').key).toBe('escape');
  });

  it('renders platform key caps', () => {
    expect(chordLabels('mod+k', false)).toEqual(['Ctrl', 'K']);
    expect(chordLabels('mod+k', true)).toEqual(['⌘', 'K']);
    expect(hotkeyLabels('g d', false)).toEqual([['G'], ['D']]);
  });
});

describe('matching', () => {
  it('fires single keys and modifier chords, and prevents the default action', () => {
    const palette = register('mod+k');
    const help = register('?');
    const event = press('k', { ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    press('?', { shiftKey: true });
    expect(help).toHaveBeenCalledTimes(1);
    press('k');
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it('supports sequences within the timeout', () => {
    vi.useFakeTimers();
    const dashboard = register('g d');
    const inbox = register('g i');
    press('g');
    press('d');
    expect(dashboard).toHaveBeenCalledTimes(1);
    press('g');
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 50);
    press('i');
    expect(inbox).not.toHaveBeenCalled();
    press('d');
    expect(dashboard).toHaveBeenCalledTimes(1);
  });

  it('never fires while typing, unless the shortcut opts in', () => {
    const create = register('c');
    const palette = register('mod+k', 'palette', { allowInInputs: true });
    const input = document.createElement('input');
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(input, editor);
    press('c', {}, input);
    press('c', {}, editor);
    press('c', {}, document.createElement('textarea'));
    expect(create).not.toHaveBeenCalled();
    press('k', { metaKey: true }, input);
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it('is suppressed inside dialogs and menus', () => {
    const create = register('c');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.append(button);
    document.body.append(dialog);
    press('c', {}, button);
    expect(create).not.toHaveBeenCalled();
  });

  it('lets the newest registration shadow older ones and ignores disabled ones', () => {
    const global = register('/', 'search');
    const page = register('/', 'filter');
    const disabled = register('x', 'disabled', { enabled: false });
    press('/');
    press('x');
    expect(page).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
    expect(disabled).not.toHaveBeenCalled();
  });

  it('lets any registration shadow a fallback, whichever registered first (UX-05)', () => {
    // A first page load runs the page's effects before the shell's: the page registers first.
    const page = register('/', 'Search issues');
    const shell = register('/', 'Search', { fallback: true });
    press('/');
    expect(page).toHaveBeenCalledTimes(1);
    expect(shell).not.toHaveBeenCalled();
    // Without a page binding (or with it disabled) the fallback applies.
    cleanups.shift()?.();
    press('/');
    expect(shell).toHaveBeenCalledTimes(1);
    register('/', 'Filter', { enabled: false });
    press('/');
    expect(shell).toHaveBeenCalledTimes(2);
  });

  it('recognises typing targets', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
  });
});

describe('useHotkey', () => {
  function Shortcut({ onFire }: { onFire: () => void }) {
    useHotkey('e', onFire, { description: 'Edit title', group: 'Task' });
    return <input aria-label="Title" />;
  }

  function Help() {
    const hotkeys = useRegisteredHotkeys();
    return (
      <ul>
        {hotkeys.map((hotkey) => (
          <li key={hotkey.keys}>{`${hotkey.group}: ${hotkey.description}`}</li>
        ))}
      </ul>
    );
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('registers while mounted and lists the shortcut for the help dialog', async () => {
    const onFire = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <>
        <Shortcut onFire={onFire} />
        <Help />
      </>,
    );
    expect(screen.getByText('Task: Edit title')).toBeInTheDocument();
    await user.keyboard('e');
    expect(onFire).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText('Title'), 'e');
    expect(onFire).toHaveBeenCalledTimes(1);
    unmount();
    act(() => {
      press('e');
    });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('lists only the page binding of a key the shell binds as a fallback', () => {
    function Page() {
      useHotkey('/', () => undefined, { description: 'Search issues', group: 'Issues' });
      return null;
    }
    function Shell({ children }: { children: ReactNode }) {
      useHotkey('/', () => undefined, { description: 'Search', fallback: true });
      return children;
    }
    const { rerender } = render(
      <Shell>
        <Page />
        <Help />
      </Shell>,
    );
    expect(screen.getByText('Issues: Search issues')).toBeInTheDocument();
    expect(screen.queryByText('General: Search')).not.toBeInTheDocument();
    rerender(
      <Shell>
        <Help />
      </Shell>,
    );
    expect(screen.getByText('General: Search')).toBeInTheDocument();
  });
});
