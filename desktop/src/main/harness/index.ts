import type { HarnessId } from '@shared/schemas/agentRunner';
import { claudeAdapter } from './claude';
import { codexAdapter, cursorAdapter, geminiAdapter, opencodeAdapter } from './others';
import type { HarnessAdapter } from './types';

/** Every harness the app can run, by id (BAT-24). */
export function createAdapters(): Map<HarnessId, HarnessAdapter> {
  return new Map<HarnessId, HarnessAdapter>([
    ['claude', claudeAdapter()],
    ['codex', codexAdapter],
    ['gemini', geminiAdapter],
    ['cursor', cursorAdapter],
    ['opencode', opencodeAdapter],
  ]);
}

export type { HarnessAdapter } from './types';
