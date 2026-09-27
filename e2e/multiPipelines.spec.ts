import { randomBytes } from 'node:crypto';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Several pipelines (BAT-25): adding a pipeline in Project settings → Statuses, its tab on the board, and
 * a task started in it.
 */

test('adds a pipeline, shows its tab on the board and starts a task in it', async ({ page }) => {
  await signedInUser(page);
  const slug = `pipes-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Pipes ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const res = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Game', key: 'GAME' },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  const project = (await res.json()) as { id: string; path: string };

  await page.goto(`${project.path}/settings/statuses`);
  const bar = page.getByRole('tablist', { name: 'Pipelines' });
  await expect(bar.getByRole('tab')).toHaveText([/Default/]);
  await page.getByRole('button', { name: 'New pipeline' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Modeling');
  await page.getByRole('button', { name: 'Add pipeline' }).click();
  await expect(bar.getByRole('tab', { name: /Modeling/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('status-row')).toHaveCount(2);

  // A task in Modeling, then the board's tabs.
  const pipelines = (await (
    await page.request.get(`/api/projects/${project.id}/pipelines`)
  ).json()) as { items: Array<{ id: string; name: string }> };
  const modeling = pipelines.items.find((item) => item.name === 'Modeling');
  const task = await page.request.post(`/api/projects/${project.id}/tasks`, {
    data: { title: 'Sculpt the tree', pipelineId: modeling?.id },
    headers: ORIGIN,
  });
  expect(task.status(), await task.text()).toBe(201);

  await page.goto(`${project.path}/tasks`);
  const tabs = page.getByRole('tablist', { name: 'Pipelines' });
  await expect(tabs.getByRole('tab')).toHaveText([/All/, /Default/, /Modeling/]);
  await tabs.getByRole('tab', { name: /Default/ }).click();
  await expect(page.getByRole('link', { name: /Sculpt the tree/ })).toHaveCount(0);
  await tabs.getByRole('tab', { name: /Modeling/ }).click();
  await expect(page.getByRole('link', { name: /Sculpt the tree/ })).toBeVisible();
});
