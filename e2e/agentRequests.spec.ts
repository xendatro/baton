import { randomBytes, randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { createApiKeyResponseSchema } from '../shared/schemas/core.ts';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test, withDatabase } from './support/fixtures.ts';

/**
 * Agent access: a teammate who may only ask mentions the owner's agent. The owner sees a
 * Request (sidebar badge, notification), approves it with a model their computer reports, and
 * the job becomes runnable with that model.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test('a teammate’s mention is a request the owner approves with a model', async ({
  page,
  browser,
  playwright,
}) => {
  const owner = await signedInUser(page);
  const slug = `req-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `Req ${slug}`, slug });
  const project = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Requests',
    key: 'REQ',
  });
  const task = await post<{ id: string; number: number }>(
    page,
    `/api/projects/${project.id}/tasks`,
    { title: 'Profile the CSV export' },
  );
  const { key } = createApiKeyResponseSchema.parse(
    await post(page, '/api/me/api-keys', { name: 'Desktop' }),
  );

  // The owner's desktop app reports Codex with its models and efforts.
  const agent = await playwright.request.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${key}` },
  });
  try {
    const registered = await agent.post('/api/agent/runners', {
      data: {
        machineId: `machine-${slug}`,
        machineName: 'MSI',
        harnesses: [
          {
            id: 'codex',
            version: '0.150.0',
            models: [{ id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'medium', 'high'] }],
            efforts: ['low', 'medium', 'high'],
          },
          { id: 'claude', version: '2.1.0', models: [{ id: 'opus' }], efforts: ['high', 'max'] },
        ],
        projectIds: [project.id],
      },
    });
    expect(registered.status(), await registered.text()).toBe(200);
  } finally {
    await agent.dispose();
  }

  // Caden, a teammate (everyone may ask by default), mentions the owner's agent.
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const matePage = await context.newPage();
  const mate = await signedInUser(matePage);
  withDatabase((db) => {
    const id = (db.prepare('select id from user where email = ?').get(mate.email) as { id: string })
      .id;
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      team.id,
      id,
      Date.now(),
    );
  });
  await post(matePage, '/api/replies', {
    parentType: 'task',
    parentId: task.id,
    body: `@${owner.username}-ai can you profile the CSV writer?`,
  });
  await context.close();

  // The owner: a Requests badge in the sidebar, and the request as a card.
  await page.goto('/');
  const link = page.getByRole('link', { name: /^Requests/ }).first();
  await expect(link).toContainText('1');
  await link.click();
  await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible();
  const card = page.getByRole('article', { name: /^Request: Reply to .*’s message on REQ-1/ });
  await expect(card).toContainText('Can I reply to');
  await expect(card).toContainText('can you profile the CSV writer?');

  // Run with Codex · gpt-5 · high, then Approve.
  await card.getByRole('combobox', { name: 'Run with (REQ-1): harness' }).selectOption('codex');
  await card.getByRole('combobox', { name: 'Run with (REQ-1): model' }).selectOption('gpt-5');
  await card.getByRole('combobox', { name: 'Run with (REQ-1): effort' }).selectOption('high');
  await card.getByRole('button', { name: /^Approve: / }).click();
  await expect(page.getByText(/^Approved: /)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recently decided' })).toContainText(
    'runs with Codex · gpt-5 · high',
  );

  // The job is runnable, with the chosen model.
  const job = withDatabase(
    (db) =>
      db
        .prepare(
          `select needs_ok, status, model_override, request_decision from agent_job
           where target_id = ? and kind = 'mention'`,
        )
        .get(task.id) as {
        needs_ok: number;
        status: string;
        model_override: string;
        request_decision: string;
      },
  );
  expect(job).toMatchObject({ needs_ok: 0, status: 'pending', request_decision: 'approved' });
  expect(JSON.parse(job.model_override)).toEqual([
    { harness: 'codex', model: 'gpt-5', effort: 'high' },
  ]);
});
