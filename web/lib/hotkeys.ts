import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Keyboard shortcuts (SPEC §1.9). Components register shortcuts with `useHotkey` for as long as
 * they are mounted, so a page's shortcuts exist only on that page and the `?` dialog lists exactly
 * what works right now. When two registrations share keys, the most recent one wins, except that
 * an app-wide `fallback` registration (the shell's `/` opens the palette) always loses to any other
 * registration of the same keys, whichever registered first: on a first page load React runs the
 * page's effects before the shell's, so "most recent" alone would let the shell win there.
 *
 * Syntax: chords joined by spaces form a sequence (`g d`); a chord is modifiers plus a key joined
 * by `+` (`mod+k`, `shift+enter`, `?`, `escape`). `mod` is ⌘ on macOS and Ctrl elsewhere.
 *
 * Shortcuts never fire while the user types in an input, textarea, select or rich-text editor,
 * or while focus is inside a dialog or menu, unless the registration opts in.
 */

export interface HotkeyOptions {
  /** Shown in the shortcuts dialog. */
  description: string;
  /** Section in the shortcuts dialog (default `General`). */
  group?: string;
  /** Registered but inactive when false (default true). */
  enabled?: boolean;
  /** Also fire while typing in a field (for `mod+…` shortcuts such as the palette). */
  allowInInputs?: boolean;
  /** Also fire while focus is inside a dialog or menu. */
  allowInDialogs?: boolean;
  /** Hide from the shortcuts dialog. */
  hidden?: boolean;
  /**
   * App-wide default: any other registration of the same keys shadows it, whatever the order of
   * registration (and the shortcuts dialog then lists only the page's binding).
   */
  fallback?: boolean;
}

interface Chord {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

interface Registration {
  id: number;
  keys: string;
  sequence: Chord[];
  handler: (event: KeyboardEvent) => void;
  options: HotkeyOptions;
}

export interface RegisteredHotkey {
  keys: string;
  description: string;
  group: string;
}

/** Time allowed between the keys of a sequence. */
export const SEQUENCE_TIMEOUT_MS = 1000;

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

export function parseChord(text: string): Chord {
  // A literal `+` key is written as the last part, e.g. `shift++`.
  const parts = text === '+' ? ['+'] : text.split('+');
  if (text.endsWith('++')) parts.splice(-2, 2, '+');
  const chord: Chord = { key: '', mod: false, shift: false, alt: false };
  for (const raw of parts) {
    const part = raw.toLowerCase();
    if (part === 'mod' || part === 'ctrl' || part === 'cmd' || part === 'meta') chord.mod = true;
    else if (part === 'shift') chord.shift = true;
    else if (part === 'alt' || part === 'option') chord.alt = true;
    else chord.key = KEY_ALIASES[part] ?? part;
  }
  if (!chord.key) throw new Error(`Hotkey "${text}" has no key`);
  return chord;
}

export function parseHotkey(keys: string): Chord[] {
  return keys.trim().split(/\s+/).map(parseChord);
}

/** Symbols typed with Shift on some layouts (`?`, `/`, …): Shift is not compared for them. */
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9 ]/.test(key);
}

export function chordMatches(chord: Chord, event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== chord.key) return false;
  if ((event.ctrlKey || event.metaKey) !== chord.mod) return false;
  if (event.altKey !== chord.alt) return false;
  if (!isSymbol(chord.key) && event.shiftKey !== chord.shift) return false;
  return true;
}

/** True when keys typed at `target` belong to a text field or rich-text editor. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(
      target.type,
    );
  }
  return false;
}

function isInOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]') !== null
  );
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

const registrations = new Map<number, Registration>();
const storeListeners = new Set<() => void>();
let nextId = 1;
let snapshot: RegisteredHotkey[] = [];
let pending: { chords: Chord[]; at: number } | null = null;
let installed = false;

/** Keys bound by an enabled registration that is not a fallback. */
function primaryKeys(): Set<string> {
  const keys = new Set<string>();
  for (const { options, keys: bound } of registrations.values()) {
    if (!options.fallback && options.enabled !== false) keys.add(bound);
  }
  return keys;
}

function refreshSnapshot(): void {
  const seen = new Set<string>();
  const list: RegisteredHotkey[] = [];
  const shadowing = primaryKeys();
  for (const registration of registrations.values()) {
    const { options, keys } = registration;
    if (options.hidden || options.enabled === false) continue;
    if (options.fallback && shadowing.has(keys)) continue;
    const id = `${keys}\u0000${options.description}`;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({ keys, description: options.description, group: options.group ?? 'General' });
  }
  snapshot = list;
  for (const listener of storeListeners) listener();
}

function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;
}

function isActive(registration: Registration, event: KeyboardEvent): boolean {
  const { options } = registration;
  if (options.enabled === false) return false;
  if (!options.allowInInputs && isTypingTarget(event.target)) return false;
  if (!options.allowInDialogs && isInOverlay(event.target)) return false;
  return true;
}

/** Newest registration first, so later registrations shadow earlier ones; fallbacks last. */
function candidates(): Registration[] {
  const newestFirst = [...registrations.values()].reverse();
  return [
    ...newestFirst.filter(({ options }) => !options.fallback),
    ...newestFirst.filter(({ options }) => options.fallback),
  ];
}

function fire(registration: Registration, event: KeyboardEvent): void {
  event.preventDefault();
  registration.handler(event);
}

export function handleKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  if (['shift', 'control', 'alt', 'meta'].includes(event.key.toLowerCase())) return;

  const active = candidates().filter((registration) => isActive(registration, event));
  const now = Date.now();

  if (pending && now - pending.at <= SEQUENCE_TIMEOUT_MS) {
    const prefix = pending.chords;
    const match = active.find(
      ({ sequence }) =>
        sequence.length === prefix.length + 1 &&
        prefix.every((chord, index) => sameChord(chord, sequence[index] as Chord)) &&
        chordMatches(sequence[prefix.length] as Chord, event),
    );
    pending = null;
    if (match) {
      fire(match, event);
      return;
    }
  }
  pending = null;

  const single = active.find(
    ({ sequence }) => sequence.length === 1 && chordMatches(sequence[0] as Chord, event),
  );
  if (single) {
    fire(single, event);
    return;
  }

  const starter = active.find(
    ({ sequence }) => sequence.length > 1 && chordMatches(sequence[0] as Chord, event),
  );
  if (starter) pending = { chords: [starter.sequence[0] as Chord], at: now };
}

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', handleKeydown);
}

/** Registers a shortcut until the returned function is called. */
export function registerHotkey(
  keys: string,
  handler: (event: KeyboardEvent) => void,
  options: HotkeyOptions,
): () => void {
  install();
  const id = nextId++;
  registrations.set(id, { id, keys, sequence: parseHotkey(keys), handler, options });
  refreshSnapshot();
  return () => {
    registrations.delete(id);
    refreshSnapshot();
  };
}

/** Registers a shortcut while the component is mounted. The latest `handler` is always called. */
export function useHotkey(
  keys: string,
  handler: (event: KeyboardEvent) => void,
  options: HotkeyOptions,
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const { description, group, enabled, allowInInputs, allowInDialogs, hidden, fallback } = options;
  useEffect(
    () =>
      registerHotkey(keys, (event) => latest.current(event), {
        description,
        group,
        enabled,
        allowInInputs,
        allowInDialogs,
        hidden,
        fallback,
      }),
    [keys, description, group, enabled, allowInInputs, allowInDialogs, hidden, fallback],
  );
}

function subscribe(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

/** Every visible, enabled shortcut currently registered (for the `?` dialog). */
export function useRegisteredHotkeys(): RegisteredHotkey[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

// ---------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);
}

const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: 'Enter',
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  backspace: 'Backspace',
  tab: 'Tab',
};

/** Key caps for one chord, e.g. `mod+k` → `['Ctrl', 'K']` (`['⌘', 'K']` on macOS). */
export function chordLabels(text: string, mac = isMac()): string[] {
  const chord = parseChord(text);
  const labels: string[] = [];
  if (chord.mod) labels.push(mac ? '⌘' : 'Ctrl');
  if (chord.alt) labels.push(mac ? '⌥' : 'Alt');
  if (chord.shift) labels.push(mac ? '⇧' : 'Shift');
  labels.push(KEY_LABELS[chord.key] ?? chord.key.toUpperCase());
  return labels;
}

/** Key caps for each chord of a shortcut: `g d` → `[['G'], ['D']]`. */
export function hotkeyLabels(keys: string, mac = isMac()): string[][] {
  return keys
    .trim()
    .split(/\s+/)
    .map((chord) => chordLabels(chord, mac));
}

// ---------------------------------------------------------------------------------------------
// Shortcuts help dialog (`?`), opened from the shell, the user menu and the palette
// ---------------------------------------------------------------------------------------------

let helpOpen = false;
const helpListeners = new Set<() => void>();

export function setShortcutsHelpOpen(open: boolean): void {
  if (helpOpen === open) return;
  helpOpen = open;
  for (const listener of helpListeners) listener();
}

export function useShortcutsHelpOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      helpListeners.add(listener);
      return () => {
        helpListeners.delete(listener);
      };
    },
    () => helpOpen,
    () => false,
  );
}
