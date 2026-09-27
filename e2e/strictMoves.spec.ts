import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test, trimToOpenAndDone } from './support/fixtures.ts';

/**
 * Strict moves (BAT-27): the task page's green "Move to <next>" and amber "Send back…" with its
 * reason dialog, and board drags that grey out the columns a card can't go to and ask for the
 * reason before a move back.
 */

async function api<T>(
  page: Page,
  method: 'post' | 'put' | 'patch',
  url: string,
  data: unknown,
): Promise<T> {
  const res = await page.request[method](url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

function column(page: Page, name: string) {
  return page.getByRole('region', { name: 'Board' }).getByRole('region', { name, exact: true });
}

/** Open → Build → Review → Done; Review needs a demo and can send back to Build only. */
async function setup(page: Page) {
  await signedInUser(page);
  const slug = `strict-${randomBytes(4).toString('hex')}`;
  const team = await api<{ id: string }>(page, 'post', '/api/teams', { name: `S ${slug}`, slug });
  const project = await api<{ id: string; statuses: Array<{ id: string; name: string }> }>(
    page,
    'post',
    `/api/teams/${team.id}/projects`,
    { name: 'Strict', key: 'STR' },
  );
  const [open, done] = await trimToOpenAndDone(page.request, project.id);
  const build = await api<{ id: string }>(page, 'post', `/api/projects/${project.id}/statuses`, {
    name: 'Build',
  });
  const review = await api<{ id: string }>(page, 'post', `/api/projects/${project.id}/statuses`, {
    name: 'Review',
    // BAT-34: the test starts a task straight in it.
    rules: { allowCreate: true },
  });
  await api(page, 'put', `/api/projects/${project.id}/statuses/order`, {
    statusIds: [open.id, build.id, review.id, done.id],
  });
  await api(page, 'patch', `/api/statuses/${review.id}`, {
    rules: { sendBackTo: [build.id], exitCriteria: [{ id: 'demo', text: 'Demo recorded' }] },
  });
  const task = await api<{ id: string; path: string }>(
    page,
    'post',
    `/api/projects/${project.id}/tasks`,
    { title: 'Strict task', statusId: review.id },
  );
  return { slug, task };
}

test('the task page moves on with the green button and sends back with a reason', async ({
  page,
}) => {
  const { task } = await setup(page);
  await page.goto(task.path);
  const stage = page.getByTestId('stage-panel');
  const details = page.getByRole('complementary', { name: 'Task details' });

  // Blocked forward: disabled, and what is missing is listed.
  await expect(stage.getByRole('button', { name: 'Move to Done' })).toBeDisabled();
  await expect(stage.getByText('To move on to Done, it still needs:')).toBeVisible();

  // Send back: the reason is required.
  await stage.getByRole('button', { name: 'Send back…' }).click();
  const dialog = page.getByTestId('send-back-dialog');
  await expect(dialog.getByText('Back to Build', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Send back to Build' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Give a reason');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('The demo crashes on start');
  await dialog.getByRole('button', { name: 'Send back to Build' }).click();
  await expect(details.getByRole('button', { name: 'Status: Build' })).toBeVisible();
  await expect(page.getByTestId('return-reason')).toContainText('The demo crashes on start');
  // The reason is a reply in the conversation; the move itself is in the Activity drawer.
  await expect(
    page
      .getByRole('list', { name: 'Conversation' })
      .getByText('Sent back from Review: The demo crashes on start'),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Activity/ }).click();
  const history = page.getByRole('list', { name: 'History' });
  await expect(history.getByText(/moved from Review to Build/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(history).toBeHidden();

  // Forward again with the green button.
  await stage.getByRole('button', { name: 'Move to Review' }).click();
  await expect(details.getByRole('button', { name: 'Status: Review' })).toBeVisible();
  await expect(page.getByTestId('return-reason')).toBeHidden();
});

test('board drags grey out the columns a card can’t go to and ask why for a move back', async ({
  page,
}) => {
  const { slug, task } = await setup(page);
  await page.goto(`/t/${slug}/p/STR/tasks`);
  const card = column(page, 'Review').getByRole('link', { name: /Strict task/ });
  await expect(card).toBeVisible();
  const from = await card.boundingBox();
  const to = await column(page, 'Build').boundingBox();
  if (!from || !to) throw new Error('no layout');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 4 });
  // Open is neither the next stage nor a send-back stage: greyed out.
  await expect(column(page, 'Open')).toHaveAttribute('aria-disabled', 'true');
  await expect(column(page, 'Build')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(column(page, 'Done')).not.toHaveAttribute('aria-disabled', 'true');
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 12 });
  await page.mouse.up();

  // Nothing moves until the reason is given.
  const dialog = page.getByTestId('send-back-dialog');
  await expect(dialog).toBeVisible();
  const pending = await page.request.get(`/api/tasks/${task.id}`);
  expect(((await pending.json()) as { status: { name: string } }).status.name).toBe('Review');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Needs another pass');
  await dialog.getByRole('button', { name: 'Send back to Build' }).click();
  await expect(column(page, 'Build').getByRole('link', { name: /Strict task/ })).toBeVisible();
  await expect(column(page, 'Open')).not.toHaveAttribute('aria-disabled', 'true');
});
