import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { createApiKeyResponseSchema } from '../shared/schemas/core.ts';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * "Your agent isn't connected to this project": mentioning your own agent where no runner or
 * listener takes the project's jobs shows the notice with Connect now, until a runner maps it.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test('the notice shows until a runner takes the project', async ({ page, playwright }) => {
  const owner = await signedInUser(page);
  const slug = `conn-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `Conn ${slug}`, slug });
  const project = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Connected',
    key: 'CON',
  });
  const task = await post<{ id: string; number: number }>(
    page,
    `/api/projects/${project.id}/tasks`,
    { title: 'Wire it up' },
  );
  const { key } = createApiKeyResponseSchema.parse(
    await post(page, '/api/me/api-keys', { name: 'Desktop' }),
  );
  await post(page, '/api/replies', {
    parentType: 'task',
    parentId: task.id,
    body: `Could you take this @${owner.username}-ai`,
  });

  // The task page: the job waits for the agent, which nothing takes here.
  await page.goto(`/t/${slug}/p/CON/tasks/${task.number}`);
  const notice = page.getByTestId('agent-connection-notice').first();
  await expect(notice).toContainText('Your agent isn’t connected to Connected');
  await expect(notice).toContainText('1 job for your agent on this task.');
  await notice.getByRole('button', { name: 'Connect now' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('This computer → Folders');
  await expect(dialog).toContainText(`start_listener { projects: ["${slug}/CON"] }`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The board says it too.
  await page.goto(`/t/${slug}/p/CON/tasks`);
  await expect(page.getByTestId('agent-connection-notice')).toContainText(
    '1 job waiting for your agent.',
  );

  // The desktop app on a machine maps the project: the notice goes away (live).
  const agent = await playwright.request.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${key}` },
  });
  try {
    const registered = await agent.post('/api/agent/runners', {
      data: {
        machineId: `machine-${slug}`,
        machineName: 'MSI',
        harnesses: [{ id: 'claude', version: '2.1.0' }],
        projectIds: [project.id],
      },
    });
    expect(registered.status(), await registered.text()).toBe(200);
  } finally {
    await agent.dispose();
  }
  await expect(page.getByTestId('agent-connection-notice')).toHaveCount(0);

  // Your settings for the project say where it runs.
  await page.goto(`/t/${slug}/p/CON/me`);
  await expect(page.getByTestId('agent-connection-ok')).toContainText(
    'Connected: your agent’s jobs here run on Baton on MSI.',
  );
});
