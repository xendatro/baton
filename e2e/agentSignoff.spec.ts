import { randomBytes } from 'node:crypto';
import { pendingApprovalResponseSchema } from '../shared/schemas/agentActions.ts';
import { createApiKeyResponseSchema } from '../shared/schemas/core.ts';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Human sign-off for agents' destructive actions (docs/design/agents-and-pipelines.md §6): an
 * agent's key asks to delete a task, the owner approves it from the inbox, and the task is in
 * Trash.
 */

test('an agent’s delete waits for the owner, who approves it in the inbox', async ({
  page,
  playwright,
}) => {
  const owner = await signedInUser(page);
  const slug = `signoff-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Sign-off ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const project = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Rocket', key: 'RKT' },
    headers: ORIGIN,
  });
  expect(project.status(), await project.text()).toBe(201);
  const { id: projectId } = (await project.json()) as { id: string };
  const task = await page.request.post(`/api/projects/${projectId}/tasks`, {
    data: { title: 'Launch the rocket' },
    headers: ORIGIN,
  });
  expect(task.status(), await task.text()).toBe(201);
  const { id: taskId, number } = (await task.json()) as { id: string; number: number };

  const created = await page.request.post('/api/me/api-keys', {
    data: { name: 'Laptop' },
    headers: ORIGIN,
  });
  expect(created.status()).toBe(201);
  const { key } = createApiKeyResponseSchema.parse(await created.json());

  // The agent's key asks; nothing happens yet.
  const agent = await playwright.request.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${key}` },
  });
  try {
    const asked = await agent.delete(`/api/tasks/${taskId}`);
    expect(asked.status(), await asked.text()).toBe(202);
    const pending = pendingApprovalResponseSchema.parse(await asked.json());
    expect(pending.message).toContain('has to approve this');
    expect((await agent.get(`/api/tasks/${taskId}`)).status()).toBe(200);
  } finally {
    await agent.dispose();
  }

  // The owner finds the request in the inbox and approves it.
  const sentence = `${owner.name} AI wants to delete RKT-${number} “Launch the rocket”`;
  await page.goto('/inbox');
  const row = page.getByTestId('notification').filter({ hasText: sentence });
  await expect(row).toContainText('needs your sign-off');
  await row.getByRole('button', { name: `Approve: ${sentence}` }).click();
  await expect(page.getByText(`Approved: delete RKT-${number} “Launch the rocket”`)).toBeVisible();
  await expect(row.getByTestId('agent-action-outcome')).toHaveText('Approved');
  await expect(row.getByRole('button', { name: /^Approve/ })).toHaveCount(0);

  // The task is in Trash, deleted by the agent.
  await page.goto(`/t/${slug}/settings/trash`);
  await expect(
    page.getByTestId('trash-row').filter({ hasText: 'Launch the rocket' }),
  ).toBeVisible();
  expect((await page.request.get(`/api/tasks/${taskId}`)).status()).toBe(404);
});
