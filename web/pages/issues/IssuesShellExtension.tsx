import { MessageSquarePlusIcon, MessagesSquareIcon } from 'lucide-react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { usePaletteCommands } from '@web/components/palette/registry';
import { useMe } from '@web/lib/auth';
import { useHotkey } from '@web/lib/hotkeys';
import { findProject, findTeam } from '@web/lib/routeContext';

/**
 * App-wide issue shortcuts while any page of a project is open: `i` and the palette's
 * "New issue" (for members with `CREATE_ISSUES`), and "Issues" to jump to the list.
 */
export default function IssuesShellExtension() {
  const location = useLocation();
  const navigate = useNavigate();
  const me = useMe().data;
  const match = matchPath({ path: '/t/:team/p/:key', end: false }, location.pathname);
  const team = me && match ? findTeam(me.teams, match.params.team) : null;
  const project = findProject(team, match?.params.key);
  const base = team && project ? `/t/${team.slug}/p/${project.key}` : null;
  const canCreate = team?.permissions.includes('CREATE_ISSUES') ?? false;
  const onNewIssuePage = base !== null && location.pathname === `${base}/issues/new`;

  const newIssue = () => {
    if (base) void navigate(`${base}/issues/new`);
  };
  useHotkey('i', newIssue, {
    description: 'New issue',
    group: 'Project',
    enabled: canCreate && base !== null && !onNewIssuePage,
  });
  usePaletteCommands(
    base && project
      ? [
          ...(canCreate
            ? [
                {
                  id: `issues.${project.id}.new`,
                  label: 'New issue',
                  group: 'Actions',
                  icon: MessageSquarePlusIcon,
                  keywords: ['create issue', 'open issue', 'report bug', project.key],
                  shortcut: 'i',
                  perform: newIssue,
                },
              ]
            : []),
          {
            id: `issues.${project.id}.list`,
            label: `${project.name} › Issues`,
            group: 'Project',
            icon: MessagesSquareIcon,
            keywords: [project.key, 'issues list', 'forum', 'bugs'],
            shortcut: 'g l',
            perform: () => void navigate(`${base}/issues`),
          },
        ]
      : [],
  );
  return null;
}
