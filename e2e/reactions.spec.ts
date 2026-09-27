import { randomBytes } from 'node:crypto';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/** Emoji reactions (BAT-14): quick reactions, the full picker, and toggling your own off. */

test('reacts to a task and a reply, and takes the reactions back', async ({ page }) => {
  await signedInUser(page);
  const slug = `react-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Reactions ${slug}`, slug },
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
    data: { title: 'Launch the rocket', description: 'Countdown from ten.' },
    headers: ORIGIN,
  });
  expect(task.status(), await task.text()).toBe(201);
  const { id: taskId, path } = (await task.json()) as { id: string; path: string };
  const reply = await page.request.post('/api/replies', {
    data: { parentType: 'task', parentId: taskId, body: 'Fuel is loaded.' },
    headers: ORIGIN,
  });
  expect(reply.status(), await reply.text()).toBe(201);

  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Launch the rocket' })).toBeVisible();

  // One click on a quick reaction under the description.
  const description = page.getByRole('region', { name: 'Description' });
  await description.getByRole('group', { name: 'Reactions' }).hover();
  await description.getByRole('button', { name: 'React with 🔥' }).click();
  const fire = description.getByRole('button', { name: 'React with 🔥 (1)' });
  await expect(fire).toHaveAttribute('aria-pressed', 'true');

  // Any other emoji through the picker, on the reply.
  const replyItem = page.getByRole('article', { name: /Reply by/ });
  await replyItem.getByRole('button', { name: 'Add reaction' }).click();
  await page.getByPlaceholder('Search emoji').fill('rocket');
  await page
    .getByRole('button', { name: /rocket/i })
    .first()
    .click();
  const rocket = replyItem.getByRole('button', { name: 'React with 🚀 (1)' });
  await expect(rocket).toHaveAttribute('aria-pressed', 'true');

  // Both are saved.
  await page.reload();
  await expect(fire).toHaveAttribute('aria-pressed', 'true');
  await expect(rocket).toHaveAttribute('aria-pressed', 'true');

  // Clicking your own reaction again removes it.
  await fire.click();
  await expect(description.getByRole('button', { name: /React with 🔥 \(/ })).toHaveCount(0);
  await rocket.click();
  await expect(replyItem.getByRole('button', { name: /React with 🚀/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Launch the rocket' })).toBeVisible();
  await expect(page.getByRole('button', { name: /React with (🔥|🚀) \(/ })).toHaveCount(0);
});
