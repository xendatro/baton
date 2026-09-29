import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_FALLBACK_EFFORTS,
  parseChoices,
  parseClaudeHelp,
  parseCliHelp,
  parseCodexModelsCache,
  parseOpencodeModels,
} from '../src/main/harness/capabilities';
import { codexModelsCachePath, discoverCodex } from '../src/main/harness/others';
import { Runner, type RunnerStore } from '../src/main/runner';
import type { BatonApi } from '../src/main/api';
import type { HarnessAdapter } from '../src/main/harness/types';

/** What the desktop app reports each harness offers (models and efforts), from fixtures. */

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]              Enable debug mode
  --effort <level>                  Effort level for the current session (low, medium, high,
                                    xhigh, max)
  --model <model>                   Model for the current session. Provide an alias for the
                                    latest model (e.g. 'fable', 'opus', or 'sonnet') or a
                                    model's full name (e.g. 'claude-opus-5-5').
  --resume [value]                  Resume a conversation
`;

describe('Claude Code --help', () => {
  it('reads the efforts and the models', () => {
    const caps = parseClaudeHelp(CLAUDE_HELP);
    expect(caps.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(caps.models.map((model) => model.id)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'fable',
      'claude-opus-5-5',
    ]);
    expect(caps.models.every((model) => model.efforts.length === 0)).toBe(true);
  });

  it('takes other choice styles and old help without an effort flag', () => {
    expect(parseChoices('--effort <level> Effort [choices: "low", "high"]')).toEqual([
      'low',
      'high',
    ]);
    expect(parseChoices('--effort <low|medium|high>')).toEqual(['low', 'medium', 'high']);
    const old = parseClaudeHelp('  --model <model>  Model for the session\n');
    expect(old.efforts).toEqual([]);
    expect(old.models.map((model) => model.id)).toEqual(['opus', 'sonnet', 'haiku']);
  });
});

describe('Codex models cache', () => {
  it('reads models with their reasoning levels (objects)', () => {
    const models = parseCodexModelsCache({
      fetched_at: '2026-09-01T00:00:00Z',
      etag: 'x',
      models: [
        {
          slug: 'gpt-6-sol',
          display_name: 'GPT-6 Sol',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast' },
            { effort: 'medium' },
            { effort: 'high' },
            { effort: 'xhigh' },
          ],
          default_reasoning_level: 'medium',
          visibility: 'list',
        },
        { slug: 'gpt-6-mini', supported_reasoning_levels: ['minimal', 'low'] },
      ],
    });
    expect(models).toEqual([
      { id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6-mini', label: null, efforts: ['minimal', 'low'] },
    ]);
  });

  it('tolerates missing and unknown fields, other keys and hidden models', () => {
    expect(
      parseCodexModelsCache([
        { id: 'a', reasoning_efforts: [{ level: 'high' }, 7, null] },
        { name: 'b', displayName: 'Model B' },
        { slug: 'hidden-one', visibility: 'hide' },
        { slug: 'hidden-two', hidden: true },
        { display_name: 'no id at all' },
        'c',
        42,
        null,
        { slug: 'a' },
      ]),
    ).toEqual([
      { id: 'a', label: null, efforts: ['high'] },
      { id: 'b', label: 'Model B', efforts: [] },
      { id: 'c', label: null, efforts: [] },
    ]);
    expect(parseCodexModelsCache({ data: [{ model: 'd' }] })).toEqual([
      { id: 'd', label: null, efforts: [] },
    ]);
  });

  it('gives null for garbage', () => {
    expect(parseCodexModelsCache(null)).toBeNull();
    expect(parseCodexModelsCache('nope')).toBeNull();
    expect(parseCodexModelsCache({ models: 'x' })).toBeNull();
    expect(parseCodexModelsCache({ models: [] })).toBeNull();
    expect(parseCodexModelsCache({ models: [{ visibility: 'hide', slug: 'x' }] })).toBeNull();
  });

  describe('discovery', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'baton-codex-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reads the cache file under CODEX_HOME', async () => {
      expect(codexModelsCachePath({ CODEX_HOME: dir })).toBe(path.join(dir, 'models_cache.json'));
      const file = path.join(dir, 'models_cache.json');
      writeFileSync(
        file,
        JSON.stringify({
          models: [{ slug: 'gpt-6-sol', supported_reasoning_levels: [{ effort: 'high' }] }],
        }),
      );
      const caps = await discoverCodex('codex-missing-binary', '', file);
      expect(caps).toEqual({
        models: [{ id: 'gpt-6-sol', label: null, efforts: ['high'] }],
        efforts: ['high'],
      });
    });

    it('falls back to the help, then to the usual efforts', async () => {
      const file = path.join(dir, 'models_cache.json');
      writeFileSync(file, '{ not json');
      const caps = await discoverCodex(
        'codex-missing-binary',
        '  -m, --model <MODEL>  Model the agent should use (e.g. gpt-6-sol, gpt-6-mini)\n',
        file,
      );
      expect(caps.models.map((model) => model.id)).toEqual(['gpt-6-sol', 'gpt-6-mini']);
      expect(caps.efforts).toEqual(CODEX_FALLBACK_EFFORTS);
    });
  });
});

describe('other CLIs', () => {
  it('reads --model defaults and examples from help', () => {
    expect(
      parseCliHelp('  -m, --model  Model      [string] [default: "gemini-2.5-pro"]\n').models,
    ).toEqual([{ id: 'gemini-2.5-pro', label: null, efforts: [] }]);
    expect(
      parseCliHelp(
        '  --model <model>  Model to use (e.g., gpt-5, sonnet-4, sonnet-4-thinking)\n',
      ).models.map((model) => model.id),
    ).toEqual(['gpt-5', 'sonnet-4', 'sonnet-4-thinking']);
    expect(parseCliHelp('  --verbose  More output\n')).toEqual({ models: [], efforts: [] });
  });

  it('reads `opencode models`', () => {
    expect(
      parseOpencodeModels('anthropic/claude-sonnet-4\nopenai/gpt-5\n\nsome warning line\n').map(
        (model) => model.id,
      ),
    ).toEqual(['anthropic/claude-sonnet-4', 'openai/gpt-5']);
    expect(parseOpencodeModels(null)).toEqual([]);
  });
});

describe('runner detection', () => {
  function adapter(id: 'claude' | 'codex', capabilities?: HarnessAdapter['capabilities']) {
    return {
      id,
      label: id,
      headless: id,
      detect: () => Promise.resolve({ installed: true, path: `/bin/${id}`, version: '1' }),
      listModels: () => Promise.resolve([]),
      ...(capabilities ? { capabilities } : {}),
      permissionModes: [],
      run: () => Promise.reject(new Error('not run')),
    } satisfies HarnessAdapter;
  }

  it('sends each harness with the models and efforts it reports, and without them on failure', async () => {
    const runner = new Runner(
      {} as unknown as BatonApi,
      new Map<'claude' | 'codex', HarnessAdapter>([
        [
          'claude',
          adapter('claude', () =>
            Promise.resolve({
              models: [{ id: 'opus', label: null, efforts: [] }],
              efforts: ['low', 'high'],
            }),
          ),
        ],
        ['codex', adapter('codex', () => Promise.reject(new Error('broken')))],
      ]),
      {} as unknown as RunnerStore,
      null,
    );
    const found = await runner.detect();
    expect(found.get('claude')).toEqual({
      id: 'claude',
      version: '1',
      models: [{ id: 'opus', label: null, efforts: [] }],
      efforts: ['low', 'high'],
    });
    expect(found.get('codex')).toEqual({ id: 'codex', version: '1' });
  });
});
