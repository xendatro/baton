import { randomBytes, randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, ORIGIN, signedInUser, test, withDatabase } from './support/fixtures.ts';

/**
 * Pipelines (docs/design/agents-and-pipelines.md §5): a three-stage pipeline whose middle stage
 * needs evidence for one criterion and one human approval, configured on the Statuses page, and a
 * task moved through it on the task page (blocked, evidence, approval, auto-advance).
 */

async function api<T>(page: Page, method: 'post' | 'put', url: string, data: unknown): Promise<T> {
  const res = await page.request[method](url, { data, headers: ORIGIN });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

function userId(email: string): string {
  return withDatabase(
    (db) => (db.prepare('select id from user where email = ?').get(email) as { id: string }).id,
  );
}

test('a task moves through a pipeline stage with a criterion and an approval', async ({
  page,
  browser,
}) => {
  // The owner's team and project: Open → In Review → Done.
  await signedInUser(page);
  const slug = `pipe-${randomBytes(4).toString('hex')}`;
  const team = await api<{ id: string }>(page, 'post', '/api/teams', {
    name: `Pipe ${slug}`,
    slug,
  });
  const project = await api<{ id: string; statuses: Array<{ id: string; name: string }> }>(
    page,
    'post',
    `/api/teams/${team.id}/projects`,
    { name: 'Pipeline', key: 'PIP' },
  );
  const review = await api<{ id: string }>(page, 'post', `/api/projects/${project.id}/statuses`, {
    name: 'In Review',
    // BAT-34: the test starts a task straight in it.
    rules: { allowCreate: true },
  });
  const [open, done] = project.statuses;
  await api(page, 'put', `/api/projects/${project.id}/statuses/order`, {
    statusIds: [open?.id, review.id, done?.id],
  });

  // A reviewer joins the team.
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const reviewerPage = await context.newPage();
  const reviewer = await signedInUser(reviewerPage);
  withDatabase((db) => {
    db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
      team.id,
      userId(reviewer.email),
      Date.now(),
    );
  });

  // Configure In Review: one criterion and one approval from the reviewer.
  await page.goto(`/t/${slug}/p/PIP/settings/statuses`);
  await page.getByRole('button', { name: 'Edit In Review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit In Review' });
  await dialog.getByRole('button', { name: /Exit criteria/ }).click();
  await dialog.getByRole('button', { name: 'Add criterion' }).click();
  await dialog.getByRole('textbox', { name: 'Criterion 1' }).fill('Tests pass');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved exit criteria of In Review')).toBeVisible();
  await dialog.getByRole('button', { name: /Moving on/ }).click();
  await dialog.getByRole('spinbutton', { name: 'Approvals needed' }).fill('1');
  await dialog
    .getByRole('combobox', { name: 'Add to Who can approve: include' })
    .fill(`@${reviewer.username}`);
  await dialog.getByRole('option', { name: new RegExp(`@${reviewer.username} `) }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved moving on of In Review')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit In Review (2 rules set)' })).toBeVisible();

  // A task enters the stage.
  const task = await api<{ id: string; path: string }>(
    page,
    'post',
    `/api/projects/${project.id}/tasks`,
    { title: 'Ship the pipeline', statusId: review.id },
  );

  // The reviewer sees what blocks it, and the status picker says why Done is refused.
  await reviewerPage.goto(task.path);
  const stage = reviewerPage.getByTestId('stage-panel');
  await expect(stage.getByRole('heading', { name: 'Stage: In Review' })).toBeVisible();
  await expect(stage.getByText('To move on to Done, it still needs:')).toBeVisible();
  await expect(stage.getByText('evidence for “Tests pass” (criterion c1)')).toBeVisible();
  await expect(stage.getByText(/1 approval from @/)).toBeVisible();
  const details = reviewerPage.getByRole('complementary', { name: 'Task details' });
  await details.getByRole('button', { name: 'Status: In Review' }).click();
  const doneOption = reviewerPage.getByRole('option', { name: /Done/ });
  await expect(doneOption).toContainText('evidence for “Tests pass”');
  await doneOption.click();
  await expect(reviewerPage.getByText(/Can’t move to Done:/)).toBeVisible();
  await expect(details.getByRole('button', { name: 'Status: In Review' })).toBeVisible();

  // Evidence and the approval; then the reviewer moves it on.
  await stage.getByRole('textbox', { name: 'Evidence for Tests pass' }).fill('CI is green');
  await stage.getByRole('button', { name: 'Save evidence' }).click();
  await expect(reviewerPage.getByText('Evidence saved')).toBeVisible();
  await expect(stage.getByText('evidence for “Tests pass” (criterion c1)')).toBeHidden();
  await stage.getByRole('textbox', { name: 'Approval comment (optional)' }).fill('Looks good');
  await stage.getByRole('button', { name: 'Approve' }).click();
  await expect(reviewerPage.getByText('Approved', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Status: In Review' }).click();
  await reviewerPage.getByRole('option', { name: /Done/ }).click();
  await expect(details.getByRole('button', { name: 'Status: Done' })).toBeVisible();
  await reviewerPage.getByRole('button', { name: /^Activity/ }).click();
  const history = reviewerPage.getByRole('list', { name: 'History' });
  await expect(history.getByText(/approved this in/)).toBeVisible();
  await expect(history.getByText(/moved from In Review to Done/)).toBeVisible();
  await context.close();
});
