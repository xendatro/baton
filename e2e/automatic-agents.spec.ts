import { randomBytes, randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test, withDatabase } from './support/fixtures.ts';

/**
 * Automatic agents (BAT-24) on the web: the default models, whose jobs run, and a job from
 * someone else waiting for the owner's OK, run from Settings → Automatic agents.
 */

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test('models, whose jobs run and a job waiting for my OK', async ({ page, browser }) => {
  const owner = await signedInUser(page);
  const slug = `auto-${randomBytes(4).toString('hex')}`;
  const team = await post<{ id: string }>(page, '/api/teams', { name: `Auto ${slug}`, slug });
  const project = await post<{ id: string }>(page, `/api/teams/${team.id}/projects`, {
    name: 'Runner',
    key: 'RUN',
  });
  const task = await post<{ id: string }>(page, `/api/projects/${project.id}/tasks`, {
    title: 'Wire the runner',
  });
  // An API key creates the owner's agent member (@<username>-ai).
  await post(page, '/api/me/api-keys', { name: 'Desktop' });

  // A teammate mentions the owner's agent.
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
    body: `Could you take this @${owner.username}-ai`,
  });
  await context.close();

  await page.goto('/settings/automatic-agents');
  await expect(page.getByRole('heading', { name: 'Automatic agents' })).toBeVisible();

  // The job waits for the owner's OK; Run clears it.
  const waiting = page.getByRole('list', { name: 'Jobs waiting for your OK' });
  await expect(waiting.getByText('Wire the runner')).toBeVisible();
  await waiting.getByRole('button', { name: 'Run again' }).click();
  await expect(page.getByText('Your agent will run it')).toBeVisible();
  await expect(waiting).toBeHidden();

  // Whose jobs run: anyone.
  await page.getByRole('radio', { name: 'Anyone who can mention or assign my agent' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved whose jobs run')).toBeVisible();

  // Models: a fallback on the default chain (each project's own are on its Your settings page).
  const models = page.getByRole('group', { name: 'Default chain' });
  await models.getByRole('button', { name: 'Add a fallback' }).click();
  await expect(models.getByRole('combobox', { name: 'Default chain: harness 2' })).toHaveValue(
    'codex',
  );
  await expect(page.getByRole('group', { name: 'Hard chain' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save models' }).click();
  await expect(page.getByText('Saved your models')).toBeVisible();

  const saved = await page.request.get('/api/me/agent/models');
  const body = (await saved.json()) as {
    default: { chain: Array<{ harness: string }> };
    projects: Record<string, unknown>;
  };
  expect(body.default.chain.map((entry) => entry.harness)).toEqual(['claude', 'codex']);
  expect(body.projects).toEqual({});
});

test('the desktop app is one click away in the sidebar', async ({ page }) => {
  await signedInUser(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Desktop app' }).click();
  await expect(page.getByRole('heading', { name: 'The Baton desktop app' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Download for / })).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/xendatro\/baton\/releases\/latest\/download\/Baton/,
  );
});
