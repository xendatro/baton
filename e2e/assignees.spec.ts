import { randomInt } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Adding people to a task at any time: the task page's Assignees picker applies each toggle at
 * once (for the task's current stage), others watching the task see it live, and it stays after
 * a reload.
 */

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A second signed-in person in their own browser context (own client IP). */
async function secondUser(browser: Browser) {
  const context = await browser.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const page = await context.newPage();
  const user = await signedInUser(page);
  return { page, user };
}

test('adds a second assignee from the task page, live for others and after a reload', async ({
  page,
  browser,
}) => {
  const me = await signedInUser(page);
  const meRes = await page.request.get('/api/me');
  const { user: myself } = (await meRes.json()) as { user: { id: string } };
  const teamRes = await page.request.post('/api/teams', {
    data: { name: 'Assign Crew' },
    headers: ORIGIN,
  });
  expect(teamRes.status(), await teamRes.text()).toBe(201);
  const team = (await teamRes.json()) as { id: string; slug: string };
  const projectRes = await page.request.post(`/api/teams/${team.id}/projects`, {
    data: { name: 'Assigning', key: 'AS' },
    headers: ORIGIN,
  });
  const { id: projectId } = (await projectRes.json()) as { id: string };
  const taskRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
    data: { title: 'Pair on the release', assigneeUserIds: [myself.id] },
    headers: ORIGIN,
  });
  expect(taskRes.status(), await taskRes.text()).toBe(201);
  const task = (await taskRes.json()) as { id: string; path: string; status: { name: string } };
  const invite = await page.request.post(`/api/teams/${team.id}/invites`, {
    data: { expiresIn: '7d', maxUses: null },
    headers: ORIGIN,
  });
  const { code } = (await invite.json()) as { code: string };
  const mate = await secondUser(browser);
  expect(
    (await mate.page.request.post(`/api/invites/${code}/accept`, { headers: ORIGIN })).status(),
  ).toBe(200);

  // The teammate watches the task while I add them.
  await mate.page.goto(task.path);
  const mateView = mate.page.getByRole('button', { name: /^Assignees: / });
  await expect(mateView).toHaveAccessibleName(`Assignees: ${me.name}`);

  await page.goto(task.path);
  const assignees = page.getByRole('button', { name: /^Assignees: / });
  await expect(assignees).toHaveAccessibleName(`Assignees: ${me.name}`);
  await expect(page.getByText(`In ${task.status.name}`, { exact: true })).toBeVisible();
  await assignees.click();
  await expect(page.getByText(`Assigned in ${task.status.name}.`, { exact: false })).toBeVisible();
  await page.getByRole('option', { name: new RegExp(`${esc(mate.user.name)} @`) }).click();
  // Applied at once: the picker stays open, and I am still assigned.
  await expect(
    page.getByRole('option', { name: new RegExp(`${esc(mate.user.name)} @`) }),
  ).toContainText('(selected)');
  await page.keyboard.press('Escape');
  const both = new RegExp(
    `^Assignees: (${esc(me.name)}, ${esc(mate.user.name)}|${esc(mate.user.name)}, ${esc(me.name)})$`,
  );
  await expect(assignees).toHaveAccessibleName(both);

  // Live for the teammate, without a reload.
  await expect(mateView).toHaveAccessibleName(both);

  await page.reload();
  await expect(assignees).toHaveAccessibleName(both);
  const fresh = await page.request.get(`/api/tasks/${task.id}`);
  const body = (await fresh.json()) as { assignees: { users: Array<{ id: string }> } };
  expect(body.assignees.users).toHaveLength(2);
  await mate.page.context().close();
});
