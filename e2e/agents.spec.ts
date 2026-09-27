import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiKeyResponseSchema } from '../shared/schemas/core.ts';
import { E2E_BASE_URL } from './support/env.ts';
import { expect, ORIGIN, signedInUser, test } from './support/fixtures.ts';

/**
 * Agents at work (docs/design/agents-and-pipelines.md §4, §7): an agent key runs a listener for a
 * project, a person @mentions the agent in a reply and the listener hands the job over; the team's
 * Members tab shows who is online.
 */

interface ListenerJob {
  jobId: string;
  kind: string;
  target: { ref: string };
  trigger: { body: string; author: { username: string } } | null;
}

test('a listener gets the job when a person @mentions the agent; Members shows who is online', async ({
  page,
}) => {
  const user = await signedInUser(page);
  const slug = `agents-${randomBytes(4).toString('hex')}`;
  const team = await page.request.post('/api/teams', {
    data: { name: `Agents ${slug}`, slug },
    headers: ORIGIN,
  });
  expect(team.status(), await team.text()).toBe(201);
  const { id: teamId } = (await team.json()) as { id: string };
  const project = await page.request.post(`/api/teams/${teamId}/projects`, {
    data: { name: 'Listener', key: 'LSN' },
    headers: ORIGIN,
  });
  expect(project.status(), await project.text()).toBe(201);
  const { id: projectId } = (await project.json()) as { id: string };
  const task = await page.request.post(`/api/projects/${projectId}/tasks`, {
    data: { title: 'Check the build' },
    headers: ORIGIN,
  });
  expect(task.status(), await task.text()).toBe(201);
  const { id: taskId } = (await task.json()) as { id: string };

  const created = await page.request.post('/api/me/api-keys', {
    data: { name: 'Listener laptop' },
    headers: ORIGIN,
  });
  expect(created.status()).toBe(201);
  const { key } = createApiKeyResponseSchema.parse(await created.json());

  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${E2E_BASE_URL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  try {
    // The agent starts listening before anyone mentions it…
    const listening = client.callTool(
      { name: 'start_listener', arguments: { projects: [`${slug}/LSN`], timeoutSeconds: 30 } },
      undefined,
      { timeout: 60_000 },
    );
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/me/agent/activity`);
        return ((await res.json()) as { online: boolean }).online;
      })
      .toBe(true);

    // …and a person mentions it in a reply.
    const reply = await page.request.post('/api/replies', {
      data: {
        parentType: 'task',
        parentId: taskId,
        body: `@${user.username}-ai can you check the build?`,
      },
      headers: ORIGIN,
    });
    expect(reply.status(), await reply.text()).toBe(201);

    const result = await listening;
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const { jobs, sessionId } = result.structuredContent as {
      jobs: ListenerJob[];
      sessionId: string;
    };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: 'mention',
      target: { ref: `${slug}/LSN-1` },
      trigger: {
        body: `@${user.username}-ai can you check the build?`,
        author: { username: user.username },
      },
    });

    const done = await client.callTool({
      name: 'complete_job',
      arguments: { jobId: jobs[0]?.jobId },
    });
    expect(done.isError, JSON.stringify(done.content)).toBeFalsy();
    const again = await client.callTool({
      name: 'start_listener',
      arguments: { projects: ['LSN'], timeoutSeconds: 0, sessionId },
    });
    expect(again.structuredContent).toMatchObject({ sessionId, jobs: [] });
  } finally {
    await client.close();
  }

  // The Members tab: the person (this page's live connection) and the agent (its listener) are
  // online, and say so in text.
  await page.goto(`/t/${slug}/members`);
  await expect(
    page.getByRole('navigation', { name: 'Team' }).getByRole('link', { name: 'Members' }),
  ).toHaveAttribute('aria-current', 'page');
  const people = page.getByRole('region', { name: /^Members/ });
  const online = people.getByRole('list', { name: /^Online — / });
  await expect(online.getByRole('listitem').filter({ hasText: user.name })).toContainText('online');
  const agents = page.getByRole('region', { name: /^Agents/ });
  await expect(
    agents.getByRole('list', { name: 'Online — 1' }).getByRole('listitem'),
  ).toContainText(`${user.name} AI`);
  await page.screenshot({ path: 'test-results/members-tab.png', fullPage: true });
});
