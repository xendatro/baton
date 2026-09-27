import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@shared/schemas/core';
import { ActivityFeed } from '@web/pages/dashboard/ActivityFeed';
import { AuditRow } from '@web/pages/team-settings/audit-log/AuditRow';
import { ActivityRow } from './ActivityRow';

/** BAT-10: an agent's history rows read "Claude via Ethan's MSI", like its replies. */

const ethan = { id: 'u1', username: 'ethan', name: 'Ethan', image: null };

function entry(via: ActivityEntry['actor']['via']): ActivityEntry {
  return {
    id: 'a1',
    teamId: 't1',
    projectId: 'p1',
    actor: { user: ethan, via, source: 'mcp' },
    entityType: 'task',
    entityId: 'task1',
    action: 'task.status_changed',
    changes: { status: { from: 'Open', to: 'Done' } },
    meta: { ref: 'WEB-12', title: 'Fix login' },
    url: '/t/acme/p/WEB/tasks/12',
    createdAt: new Date().toISOString(),
  };
}

const withAgent = entry({ keyId: 'k1', keyName: 'MSI', agentName: 'Claude' });
const withoutAgent = entry({ keyId: 'k1', keyName: 'MSI' });

function renderAll(item: ActivityEntry) {
  return render(
    <MemoryRouter>
      <div data-testid="history">
        <ActivityRow entry={item} />
      </div>
      <ol data-testid="audit">
        <AuditRow entry={item} />
      </ol>
      <div data-testid="feed">
        <ActivityFeed entries={[item]} teams={[]} />
      </div>
    </MemoryRouter>,
  );
}

describe('agent names in activity', () => {
  it('names the agent in task history, the audit log and the dashboard feed', () => {
    renderAll(withAgent);
    for (const id of ['history', 'audit', 'feed']) {
      expect(screen.getByTestId(id)).toHaveTextContent(/Claude\s*via\s*Ethan\s*’s MSI/);
    }
  });

  it('keeps "Ethan via MSI" for keys whose agent is unknown', () => {
    renderAll(withoutAgent);
    for (const id of ['history', 'audit', 'feed']) {
      const row = screen.getByTestId(id);
      expect(row).toHaveTextContent(/Ethan/);
      expect(row).toHaveTextContent(/MSI/);
      expect(row).not.toHaveTextContent(/Claude/);
    }
  });
});
