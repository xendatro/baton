import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * New projects start with five plain stages; "New stage" creates one at once (renamed in the
 * list) or from an existing stage's settings (2026-09-27).
 */

async function api<T>(page: Page, method: 'post' | 'patch', url: string, data: unknown) {
  const res = await page.request[method](url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function setup(page: Page) {
  await signedInUser(page);
  const slug = `stage-${randomBytes(4).toString('hex')}`;
  const team = await api<{ id: string }>(page, 'post', '/api/teams', {
    name: `Stages ${slug}`,
    slug,
  });
  const project = await api<{ id: string; statuses: Array<{ id: string; name: string }> }>(
    page,
    'post',
    `/api/teams/${team.id}/projects`,
    { name: 'Stages', key: 'STG' },
  );
  return { slug, project };
}

test('a new project has five stages, and Create adds a plain one to rename in place', async ({
  page,
}) => {
  const { slug, project } = await setup(page);
  expect(project.statuses.map((status) => status.name)).toEqual([
    'Backlog',
    'To do',
    'In progress',
    'In review',
    'Done',
  ]);

  await page.goto(`/t/${slug}/p/STG/settings/pipelines`);
  const rows = page.getByTestId('status-row');
  await expect(rows).toHaveCount(5);
  await page.getByRole('button', { name: 'New stage', exact: true }).click();
  await expect(rows).toHaveCount(6);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const name = page.getByRole('textbox', { name: 'Name of status New stage' });
  await expect(name).toBeFocused();
  await page.keyboard.type('Blocked');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Name of status Blocked' })).toBeVisible();

  const statuses = await page.request.get(`/api/projects/${project.id}/statuses`);
  const items = ((await statuses.json()) as { items: Array<Record<string, unknown>> }).items;
  const blocked = items.find((item) => item.name === 'Blocked');
  expect(blocked).toMatchObject({
    position: 5,
    isDefault: false,
    rules: {
      handoff: { mode: 'keep' },
      exitCriteria: [],
      approvals: null,
      moveBy: { assignees: false, claimer: false },
      allowCreate: false,
      sendBackTo: project.statuses.map((status) => status.id),
    },
  });
});

test('Create from existing copies another stage’s settings under a new name', async ({ page }) => {
  const { slug, project } = await setup(page);
  const review = project.statuses.find((status) => status.name === 'In review');
  await api(page, 'patch', `/api/statuses/${review?.id}`, {
    rules: {
      instructions: 'Read the diff.',
      exitCriteria: [{ id: 'tests', text: 'Tests pass' }],
    },
  });

  await page.goto(`/t/${slug}/p/STG/settings/pipelines`);
  await expect(page.getByTestId('status-row')).toHaveCount(5);
  await page.getByRole('button', { name: 'More ways to create a stage' }).click();
  await page.getByRole('menuitem', { name: /Create from existing/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Security review');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('heading', { name: 'Copy settings from' })).toBeVisible();
  const source = dialog.getByRole('radio', { name: /In review/ });
  await expect(dialog.getByText('Instructions · 1 exit criterion')).toBeVisible();
  await source.click();
  await dialog.getByRole('button', { name: 'Create stage' }).click();
  await expect(
    page.getByText('Added Security review with the settings of In review'),
  ).toBeVisible();
  await expect(page.getByTestId('status-row')).toHaveCount(6);

  const statuses = await page.request.get(`/api/projects/${project.id}/statuses`);
  const items = ((await statuses.json()) as { items: Array<Record<string, unknown>> }).items;
  expect(items.find((item) => item.name === 'Security review')).toMatchObject({
    position: 5,
    rules: {
      instructions: 'Read the diff.',
      exitCriteria: [{ id: 'tests', text: 'Tests pass' }],
    },
  });
});
