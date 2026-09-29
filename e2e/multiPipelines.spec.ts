import { randomBytes } from 'node:crypto';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Pipelines (BAT-25), first-class: a new project names its first pipeline, which the sidebar and the
 * board's tabs show; adding a pipeline in Project settings → Pipelines, its tab on the board, and a
 * task started in it.
 */

test('adds a pipeline, shows its tab on the board and starts a task in it', async ({ page }) => {
  await signedInUser(page);
  const slug = `pipes-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Pipes ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const res = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Game', key: 'GAME' },
    headers: ORIGIN,
  });
  expect(res.status(), await res.text()).toBe(201);
  const project = (await res.json()) as { id: string; path: string };

  await page.goto(`${project.path}/settings/pipelines`);
  const bar = page.getByRole('tablist', { name: 'Pipelines' });
  await expect(bar.getByRole('tab')).toHaveText([/Main/]);
  await page.getByRole('button', { name: 'New pipeline' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Modeling');
  await page.getByRole('button', { name: 'Add pipeline' }).click();
  await expect(bar.getByRole('tab', { name: /Modeling/ })).toHaveAttribute('aria-selected', 'true');
  // It starts with the five default stages (the Simple board template).
  await expect(page.getByTestId('stage-node')).toHaveCount(5);

  // A task in Modeling, then the board's tabs.
  const pipelines = (await (
    await page.request.get(`/api/projects/${project.id}/pipelines`)
  ).json()) as { items: Array<{ id: string; name: string }> };
  const modeling = pipelines.items.find((item) => item.name === 'Modeling');
  const task = await page.request.post(`/api/projects/${project.id}/tasks`, {
    data: { title: 'Sculpt the tree', pipelineId: modeling?.id },
    headers: ORIGIN,
  });
  expect(task.status(), await task.text()).toBe(201);

  await page.goto(`${project.path}/tasks`);
  const tabs = page.getByRole('tablist', { name: 'Pipelines' });
  await expect(tabs.getByRole('tab')).toHaveText([/Main/, /Modeling/, /All/]);
  // The default pipeline first: its stages, not all of them.
  await expect(tabs.getByRole('tab', { name: /Main/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('link', { name: /Sculpt the tree/ })).toHaveCount(0);
  await tabs.getByRole('tab', { name: /Modeling/ }).click();
  await expect(page.getByRole('link', { name: /Sculpt the tree/ })).toBeVisible();
  // All: the cards say which pipeline they are in.
  await tabs.getByRole('tab', { name: /All/ }).click();
  await expect(
    page.getByRole('link', { name: /Sculpt the tree/ }).getByTitle('Pipeline: Modeling'),
  ).toBeVisible();
});

test('a new project names its first pipeline, shown in the sidebar, the tabs and the task page', async ({
  page,
}) => {
  await signedInUser(page);
  const slug = `tree-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Tree ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);

  await page.goto(`/t/${slug}`);
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name', { exact: true }).fill('Forest');
  const pipelineName = dialog.getByLabel('Name your first pipeline');
  await expect(pipelineName).toBeVisible();
  await expect(pipelineName).toHaveAttribute('placeholder', 'e.g. Development');
  await pipelineName.fill('Development');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/p/FOR$`));

  // The sidebar: team → project → its pipeline.
  const sidebarPipelines = page.getByRole('list', { name: 'Forest pipelines' });
  const development = sidebarPipelines.getByRole('link', { name: /Development/ });
  await expect(development).toBeVisible();
  // The overview's Pipelines card lists it with its stages.
  await expect(page.getByRole('heading', { name: 'Pipelines' })).toBeVisible();

  await development.click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/p/FOR/tasks\\?pipeline=\\w+$`));
  const tabs = page.getByRole('tablist', { name: 'Pipelines' });
  await expect(tabs.getByRole('tab')).toHaveText([/Development/]);
  await expect(tabs.getByRole('tab', { name: /Development/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(development).toHaveAttribute('aria-current', 'page');
  // The header reads Team / Project / Pipeline.
  const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
  await expect(crumbs).toContainText('Development');

  // New task: the pipeline is shown (the only one, so fixed).
  await page
    .getByRole('button', { name: /New task/ })
    .first()
    .click();
  const newTask = page.getByRole('dialog', { name: 'New task' });
  const picker = newTask.getByRole('combobox', { name: 'Pipeline' });
  await expect(picker).toContainText('Development');
  await expect(picker).toBeDisabled();
  await newTask.getByPlaceholder('Task title').fill('Plant the oaks');
  await newTask.getByRole('button', { name: 'Create task' }).click();
  await expect(newTask).toBeHidden();

  // The task page: Team › Project › Pipeline › Stage, and its Pipeline.
  await page
    .getByRole('region', { name: 'Board' })
    .getByRole('link', { name: /Plant the oaks/ })
    .click();
  const location = page.getByRole('navigation', { name: 'Task location' });
  await expect(location.getByRole('link')).toHaveText([
    `Tree ${slug}`,
    'Forest',
    'Development',
    'Backlog',
  ]);
  await location.getByRole('link', { name: 'Development' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/p/FOR/tasks\\?pipeline=\\w+$`));
});
