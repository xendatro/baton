import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * The visual pipeline editor (2026-09-29): a pipeline from the AI loop template, then a stage
 * edited in its panel, with the flow's badges following.
 */

async function api<T>(page: Page, method: 'post' | 'get', url: string, data?: unknown) {
  const res = await page.request[method](url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface StageRow {
  name: string;
  rules: {
    instructions: string;
    exitCriteria: Array<{ id: string; text: string }>;
    handoff: { mode: string; rule?: { allow: Array<Record<string, string>> } };
  };
}

test('a pipeline from the AI loop template, edited in the visual editor', async ({ page }) => {
  await signedInUser(page);
  const slug = `flow-${randomBytes(4).toString('hex')}`;
  const team = await api<{ id: string }>(page, 'post', '/api/teams', {
    name: `Flow ${slug}`,
    slug,
  });
  const project = await api<{ id: string }>(page, 'post', `/api/teams/${team.id}/projects`, {
    name: 'Flow',
    key: 'FLW',
  });

  await page.goto(`/t/${slug}/p/FLW/settings/pipelines`);
  await expect(page.getByTestId('stage-node')).toHaveCount(5);

  // New pipeline → AI loop.
  await page.getByRole('button', { name: 'New pipeline' }).click();
  const dialog = page.getByRole('dialog', { name: 'New pipeline' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Agents');
  await dialog.getByRole('radio', { name: /AI loop/ }).click();
  await dialog.getByRole('button', { name: 'Add pipeline' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Pick the agents for Plan and Build/)).toBeVisible();
  await expect(
    page.getByRole('tablist', { name: 'Pipelines' }).getByRole('tab', { name: /Agents/ }),
  ).toHaveAttribute('aria-selected', 'true');

  const editor = page.getByTestId('pipeline-editor');
  const nodes = editor.getByTestId('stage-node');
  await expect(nodes).toHaveCount(4);
  const build = nodes.nth(1);
  const review = nodes.nth(2);
  await expect(build.getByTestId('badge-criteria')).toHaveText('2');
  await expect(review.getByTestId('badge-approval')).toHaveText('Approval');
  await expect(build.getByTestId('badge-agent')).toHaveCount(0);

  // Open Build: add a check, hand it to an agent and give it instructions.
  await build.getByRole('button', { name: /^Stage 2: Build/ }).click();
  const panel = page.getByTestId('stage-panel');
  await expect(panel.getByRole('textbox', { name: 'Stage name' })).toHaveValue('Build');
  await panel.getByRole('textbox', { name: 'New check' }).fill('Lint passes');
  await panel.getByRole('textbox', { name: 'New check' }).press('Enter');
  await expect(panel.getByRole('textbox', { name: 'Check 3' })).toHaveValue('Lint passes');
  await expect(build.getByTestId('badge-criteria')).toHaveText('3');

  await panel.getByRole('switch', { name: 'An agent does this stage' }).click();
  await panel.getByRole('checkbox', { name: /Any agent in the team/ }).click();
  await expect(build.getByTestId('badge-agent')).toHaveText('every agent');

  const instructions = panel.getByRole('textbox', { name: 'Instructions' });
  await instructions.fill('Build it and open a pull request.');
  await instructions.press('Tab');
  await expect(page.getByText('Saved Build').first()).toBeVisible();

  const pipelines = await api<{ items: Array<{ id: string; name: string }> }>(
    page,
    'get',
    `/api/projects/${project.id}/pipelines`,
  );
  const agents = pipelines.items.find((item) => item.name === 'Agents');
  await expect
    .poll(async () => {
      const { items } = await api<{ items: StageRow[] }>(
        page,
        'get',
        `/api/projects/${project.id}/statuses?pipeline=${agents?.id ?? ''}`,
      );
      const row = items.find((item) => item.name === 'Build');
      return row && { ...row.rules, handoff: row.rules.handoff };
    })
    .toMatchObject({
      instructions: 'Build it and open a pull request.',
      exitCriteria: [{ id: 'tests' }, { id: 'summary' }, { id: 'c3', text: 'Lint passes' }],
      handoff: { mode: 'pool', rule: { allow: [{ type: 'everyone', scope: 'agents' }] } },
    });
});
