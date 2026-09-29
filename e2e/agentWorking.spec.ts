import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { createApiKeyResponseSchema } from '../shared/schemas/core.ts';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * BAT#42: "Ethan AI is working" only while the desktop app reports the harness running the job:
 * a claimed job shows nothing; a heartbeat naming it running puts the pulsing dot on the board
 * card, the task's header and the chat (live, no reload); completing it takes them away.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test('the working dot follows the runner’s running jobs', async ({ page, playwright }) => {
  const owner = await signedInUser(page);
  const slug = `work-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `Work ${slug}`, slug });
  const project = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Working',
    key: 'WRK',
  });
  const task = await post<{ id: string; path: string }>(page, `/api/projects/${project.id}/tasks`, {
    title: 'Profile the CSV export',
  });
  const { key } = createApiKeyResponseSchema.parse(
    await post(page, '/api/me/api-keys', { name: 'Desktop' }),
  );
  await post(page, '/api/replies', {
    parentType: 'task',
    parentId: task.id,
    body: `@${owner.username}-ai can you profile the CSV writer?`,
  });

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
    const runnerId = ((await registered.json()) as { runner: { id: string } }).runner.id;
    const next = await agent.post(`/api/agent/runners/${runnerId}/jobs/next?wait=0`);
    expect(next.status(), await next.text()).toBe(200);
    const [job] = ((await next.json()) as { jobs: Array<{ jobId: string }> }).jobs;
    expect(job).toBeDefined();
    const jobId = job?.jobId ?? '';
    const heartbeat = async (activeJobIds: string[]) => {
      const res = await agent.post(`/api/agent/runners/${runnerId}/heartbeat`, {
        data: { running: 1, jobIds: [jobId], activeJobIds },
      });
      expect(res.status(), await res.text()).toBe(200);
    };

    // Claimed and waiting (e.g. for usage): not working.
    await heartbeat([]);
    await page.goto(task.path.replace(/\/\d+$/, ''));
    await expect(page.getByText('Profile the CSV export').first()).toBeVisible();
    await expect(page.getByTestId('working-dot')).toHaveCount(0);

    // The harness runs: the dot appears on the card without a reload.
    await heartbeat([jobId]);
    await expect(page.getByRole('img', { name: /is working$/ }).first()).toBeVisible();

    // The task page: the dot by the title and the chat's line.
    await page.goto(task.path);
    await expect(page.getByRole('heading', { level: 1 }).getByTestId('working-dot')).toBeVisible();
    await expect(page.getByTestId('chat-activity')).toContainText('is working');

    // Complete: both go away live.
    const done = await agent.post(`/api/agent/jobs/${jobId}/complete`, { data: {} });
    expect(done.status(), await done.text()).toBe(200);
    await expect(page.getByTestId('chat-activity')).not.toContainText('is working');
    await expect(page.getByTestId('working-dot')).toHaveCount(0);
  } finally {
    await agent.dispose();
  }
});
