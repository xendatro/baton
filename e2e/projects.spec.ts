import { randomBytes, randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { EVERYONE_DEFAULTS } from '../shared/permissions.ts';
import {
  expect,
  ORIGIN,
  signedInUser,
  test,
  withDatabase,
  type TestUser,
} from './support/fixtures.ts';

/**
 * Projects module (SPEC §1.4–1.6): creating a project, its README, settings (key changes with
 * old-URL redirects), statuses, labels, and deleting/restoring. Teams are inserted directly, so
 * this spec does not depend on the teams module's UI.
 */

interface SeededTeam {
  id: string;
  slug: string;
}

function userId(email: string): string {
  return withDatabase(
    (db) => (db.prepare('select id from user where email = ?').get(email) as { id: string }).id,
  );
}

/** A team owned by `owner`, with `members` as plain members (only `@everyone`). */
function seedTeam(owner: TestUser, members: TestUser[] = []): SeededTeam {
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  const id = `e2e${randomBytes(8).toString('hex')}`;
  const now = Date.now();
  withDatabase((db) => {
    db.prepare(
      'insert into team (id, name, slug, color, owner_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, 'Acme', slug, '#6366f1', userId(owner.email), now, now);
    db.prepare(
      `insert into role (id, team_id, name, slug, position, permissions, mentionable, is_everyone, created_at, updated_at)
       values (?, ?, '@everyone', 'everyone', 0, ?, 0, 1, ?, ?)`,
    ).run(`${id}r`, id, JSON.stringify(EVERYONE_DEFAULTS), now, now);
    for (const user of [owner, ...members]) {
      db.prepare('insert into team_member (team_id, user_id, joined_at) values (?, ?, ?)').run(
        id,
        userId(user.email),
        now,
      );
    }
  });
  return { id, slug };
}

async function createProjectViaApi(page: Page, team: SeededTeam, body: Record<string, unknown>) {
  const res = await page.request.post(`/api/teams/${team.id}/projects`, {
    data: body,
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; key: string };
}

async function statusesOf(page: Page, projectId: string) {
  const res = await page.request.get(`/api/projects/${projectId}/statuses`);
  return (
    (await res.json()) as { items: Array<{ name: string; isDefault: boolean; category: string }> }
  ).items;
}

test('create a project from the palette, write its README, and re-key it', async ({ page }) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search or jump to…').fill('new project');
  await expect(page.getByRole('option', { name: 'New project…' })).toBeVisible();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Web app');
  await expect(dialog.getByLabel('Key')).toHaveValue('WA');
  await expect(dialog.getByText('Available')).toBeVisible();
  await dialog.getByLabel('Description').fill('The customer-facing web app');
  await dialog.getByRole('button', { name: 'Create project' }).click();

  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/WA$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Web app' })).toBeVisible();
  await expect(page.getByText('The customer-facing web app').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Web app/ }).first()).toBeVisible();

  // The README starts empty; write one with the full editor and save with Ctrl+Enter.
  await page.getByRole('button', { name: 'Write a README' }).click();
  const editor = page.getByRole('textbox', { name: 'README' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Welcome to the web app. Ship small, ship often.');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText('README saved')).toBeVisible();
  await expect(page.getByText('Welcome to the web app. Ship small, ship often.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();

  // A second project with the same name gets the next free key.
  const second = await createProjectViaApi(page, team, { name: 'Web App' });
  expect(second.key).toBe('WA2');

  // Change the key in settings: the URL follows, and old URLs redirect.
  await page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page.getByLabel('Key').fill('web');
  await expect(page.getByLabel('Key')).toHaveValue('WEB');
  await expect(page.getByText(/Old refs and links with WA keep working/)).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/WEB/settings/general$`));
  await expect(page.getByText('Project saved')).toBeVisible();

  await page.goto(`/t/${team.slug}/p/WA/issues?sort=newest`);
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/WEB/issues\\?sort=newest$`));
  await page.goto(`/t/${team.slug}/p/web`);
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/WEB$`));
  await page.goto(`/t/${team.slug}/p/NOPE`);
  await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('manage statuses: add, set default, recategorize, reorder by keyboard, delete', async ({
  page,
}) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  const project = await createProjectViaApi(page, team, { name: 'Board', key: 'BRD' });

  await page.goto(`/t/${team.slug}/p/BRD/settings/statuses`);
  await expect(page.getByRole('heading', { name: 'Statuses' })).toBeVisible();
  await expect(page.getByTestId('status-row')).toHaveCount(2);

  await page.getByLabel('New status name').fill('In review');
  await page.getByRole('button', { name: 'Add status' }).click();
  await expect(page.getByTestId('status-row')).toHaveCount(3);
  await expect(page.getByLabel('Name of status In review')).toHaveValue('In review');

  await page.getByRole('radio', { name: 'Make In review the default status' }).click();
  await expect(
    page.getByRole('radio', { name: 'Make In review the default status' }),
  ).toBeChecked();
  await expect
    .poll(async () => (await statusesOf(page, project.id)).find((s) => s.isDefault)?.name)
    .toBe('In review');

  await page.getByRole('combobox', { name: 'Category of In review' }).click();
  await page.getByRole('option', { name: 'Done' }).click();
  await expect
    .poll(
      async () =>
        (await statusesOf(page, project.id)).find((s) => s.name === 'In review')?.category,
    )
    .toBe('done');

  // Rename in place.
  const name = page.getByLabel('Name of status Open');
  await name.fill('To do');
  await name.press('Enter');
  await expect
    .poll(async () => (await statusesOf(page, project.id)).map((s) => s.name))
    .toEqual(['To do', 'Done', 'In review']);

  // Keyboard reordering: pick up, move up one, drop.
  // (dnd-kit reacts to each key on the next frame, as with a person typing.)
  const handle = page.getByRole('button', { name: 'Reorder In review' });
  await handle.focus();
  await expect(handle).toBeFocused();
  for (const key of ['Space', 'ArrowUp', 'Space']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
  await expect
    .poll(async () => (await statusesOf(page, project.id)).map((s) => s.name))
    .toEqual(['To do', 'In review', 'Done']);

  // Deleting the default status moves its tasks and passes the default on.
  await page.getByRole('button', { name: 'Delete In review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete In review?' });
  await expect(dialog.getByText(/becomes the default for new tasks/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete status' }).click();
  await expect(page.getByText('Deleted In review')).toBeVisible();
  await expect(page.getByTestId('status-row')).toHaveCount(2);
  const remaining = await statusesOf(page, project.id);
  expect(remaining.map((s) => [s.name, s.isDefault])).toEqual([
    ['To do', false],
    ['Done', true],
  ]);
});

test('manage labels: create, edit and delete with usage', async ({ page }) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  await createProjectViaApi(page, team, { name: 'Labels', key: 'LBL' });

  await page.goto(`/t/${team.slug}/p/LBL/settings/labels`);
  await expect(page.getByRole('heading', { name: 'No labels yet' })).toBeVisible();
  await page.getByRole('button', { name: 'New label' }).click();

  let dialog = page.getByRole('dialog', { name: 'New label' });
  await dialog.getByLabel('Name').fill('bug');
  await dialog.getByLabel('Description').fill('Something is broken');
  await dialog.getByRole('button', { name: 'Create label' }).click();
  await expect(page.getByTestId('label-row')).toHaveCount(1);
  await expect(page.getByTestId('label-row')).toContainText('Something is broken');

  // Names are unique ignoring case.
  await page.getByRole('button', { name: 'New label' }).click();
  dialog = page.getByRole('dialog', { name: 'New label' });
  await dialog.getByLabel('Name').fill('BUG');
  await dialog.getByRole('button', { name: 'Create label' }).click();
  await expect(dialog.getByText('There is already a label named "bug"')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Edit bug' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit label' });
  await dialog.getByLabel('Name').fill('defect');
  await dialog.getByRole('button', { name: 'Save label' }).click();
  await expect(page.getByTestId('label-row')).toContainText('defect');

  await page.getByRole('button', { name: 'Delete defect' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByText('No issues or tasks use it.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete label' }).click();
  await expect(page.getByRole('heading', { name: 'No labels yet' })).toBeVisible();
});

test('delete a project with typed confirmation, then undo', async ({ page }) => {
  const owner = await signedInUser(page);
  const team = seedTeam(owner);
  await createProjectViaApi(page, team, { name: 'Doomed', key: 'DOOM' });

  await page.goto(`/t/${team.slug}/p/DOOM/settings/general`);
  await page.getByRole('button', { name: 'Delete project' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete Doomed?' });
  const confirm = dialog.getByRole('button', { name: 'Delete project' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type DOOM to confirm/).fill('DOOM');
  await confirm.click();

  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}$`));
  await expect(page.getByText('Moved Doomed to Trash')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Doomed' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${team.slug}/p/DOOM$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Doomed' })).toBeVisible();
});

test('members without permissions see read-only settings', async ({ page, browser }) => {
  const owner = await signedInUser(page);
  const memberContext = await browser.newContext({
    extraHTTPHeaders: {
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const memberPage = await memberContext.newPage();
  const member = await signedInUser(memberPage);
  const team = seedTeam(owner, [member]);
  await createProjectViaApi(page, team, { name: 'Shared', key: 'SHR' });

  await memberPage.goto(`/t/${team.slug}/p/SHR`);
  await expect(memberPage.getByRole('heading', { name: 'No README yet' })).toBeVisible();
  await expect(memberPage.getByRole('button', { name: 'Write a README' })).toHaveCount(0);

  await memberPage.goto(`/t/${team.slug}/p/SHR/settings/general`);
  await expect(memberPage.getByText(/needs the Manage projects permission/)).toBeVisible();
  await expect(memberPage.getByLabel('Name')).toBeDisabled();
  await expect(memberPage.getByRole('button', { name: 'Delete project' })).toHaveCount(0);

  await memberPage.goto(`/t/${team.slug}/p/SHR/settings/statuses`);
  await expect(memberPage.getByText(/needs the Manage statuses permission/)).toBeVisible();
  await expect(memberPage.getByRole('button', { name: 'Add status' })).toHaveCount(0);

  // Labels are an @everyone permission.
  await memberPage.goto(`/t/${team.slug}/p/SHR/settings/labels`);
  await expect(memberPage.getByRole('button', { name: 'New label' })).toBeVisible();

  // Creating a project needs MANAGE_PROJECTS: the palette doesn't offer it.
  await memberPage.keyboard.press('Control+k');
  await memberPage.getByPlaceholder('Search or jump to…').fill('new project');
  await expect(memberPage.getByRole('option', { name: 'New project…' })).toHaveCount(0);
  await memberContext.close();
});
