import { DownloadIcon, MonitorIcon, PauseIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  DEFAULT_CHAIN,
  HARNESS_LABELS,
  type AgentUsageTotals,
  type Chain,
  type HarnessId,
} from '@shared/schemas/agentRunner';
import { MODEL_PRICES_AS_OF } from '@shared/modelPrices';
import type { AgentAccessRules, TeamAgentAccess } from '@shared/schemas/agentAccess';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { HelpTip } from '@web/components/common/HelpTip';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import type { PrincipalOptions } from '@web/components/pickers/principals';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { Skeleton } from '@web/components/ui/skeleton';
import { Switch } from '@web/components/ui/switch';
import { errorMessage } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { isDesktopApp } from '@web/lib/desktop';
import { pluralize } from '@web/lib/format';
import { useMembers, useRoles } from '../teams/api';
import {
  useAgentStats,
  useModelMappings,
  useRunners,
  useSetModelMappings,
  useWaitingJobs,
} from './automaticAgentsQueries';
import { ChainEditor } from './ChainEditor';
import { WaitingJobGroups } from './WaitingJobs';
import { AgentAccessEditor } from '@web/components/agentRequests/AgentAccessEditor';
import { useAgentAccess, useSetTeamAgentAccess } from '@web/components/agentRequests/queries';
import { chainSummary } from './chainSummary';
import { useAgentSettings, useUpdateAgentSettings } from './queries';
import { SettingsCard, SettingsCardSkeleton, SettingsPage } from './SettingsCard';

/**
 * Settings → Automatic agents (BAT-24): the Baton desktop app runs your agent's jobs in your own
 * harness (Claude Code, Codex, …). Here: your desktop apps, stopped runs, who can start your agent
 * (agent access, per team), your default models (each project's own are on its Your settings page,
 * BAT-29), usage stats and the global pause.
 */
export default function AutomaticAgentsSettingsPage() {
  return (
    <SettingsPage
      title="Automatic agents"
      description="The Baton desktop app listens for your agent’s jobs without spending tokens, and runs each one in your own harness (Claude Code, Codex, Gemini CLI, Cursor CLI, opencode) in the folder you map to its project."
    >
      <PauseCard />
      <DesktopCard />
      <WaitingCard />
      <AgentAccessCard />
      <ModelsCard />
      <StatsCard />
    </SettingsPage>
  );
}

// ---------------------------------------------------------------------------------------------
// Pause and desktop apps
// ---------------------------------------------------------------------------------------------

function PauseCard() {
  const settings = useAgentSettings();
  const update = useUpdateAgentSettings();
  const id = useId();
  if (settings.isPending) return <SettingsCardSkeleton rows={1} />;
  if (settings.isError) return null;
  const paused = settings.data.pausedAt !== null;
  return (
    <SettingsCard
      title="Pause"
      description="Stops every desktop app from taking jobs, and your agent’s keys from writing."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <PauseIcon className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Label htmlFor={id}>Pause all agents</Label>
        </div>
        <Switch
          id={id}
          checked={paused}
          disabled={update.isPending}
          onCheckedChange={(next) =>
            update.mutate(
              { paused: next },
              { onSuccess: () => toast.success(next ? 'Agents paused' : 'Agents resumed') },
            )
          }
        />
      </div>
    </SettingsCard>
  );
}

function DesktopCard() {
  const runners = useRunners();
  return (
    <SettingsCard
      title="Desktop apps"
      description="Each machine running the Baton desktop app. It takes jobs only for the projects you mapped to a folder there."
      action={
        isDesktopApp() ? (
          <Button asChild size="sm" variant="outline">
            <Link to="/desktop">This computer</Link>
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link to="/download">
              <DownloadIcon aria-hidden="true" />
              Download the app
            </Link>
          </Button>
        )
      }
    >
      {runners.isPending ? (
        <Skeleton className="h-12" />
      ) : runners.isError ? (
        <ErrorState
          title="Couldn’t load your desktop apps"
          error={runners.error}
          onRetry={() => void runners.refetch()}
        />
      ) : runners.data.length === 0 ? (
        <EmptyState
          icon={MonitorIcon}
          title="No desktop app yet"
          description="Install the Baton desktop app and sign in: its setup guide detects your harnesses, maps projects to folders and runs a test job."
          action={
            <Button asChild>
              <Link to="/download">
                <DownloadIcon aria-hidden="true" />
                Download the desktop app
              </Link>
            </Button>
          }
          className="py-6"
        />
      ) : (
        <ul className="divide-y" aria-label="Desktop apps">
          {runners.data.map((runner) => (
            <li key={runner.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <MonitorIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="font-medium">{runner.machineName}</span>
              <Badge variant={runner.online ? 'default' : 'secondary'}>
                {runner.online ? 'Online' : 'Offline'}
              </Badge>
              {runner.online && runner.running > 0 ? (
                <span className="text-sm">{pluralize(runner.running, 'job')} running</span>
              ) : null}
              <span className="text-sm text-muted-foreground">
                {runner.harnesses.map((harness) => HARNESS_LABELS[harness.id]).join(', ') ||
                  'No harnesses'}
                {' · '}
                {pluralize(runner.projectIds.length, 'project')}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                Seen <RelativeTime value={runner.lastSeenAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

function WaitingCard() {
  const waiting = useWaitingJobs();
  if (waiting.isPending || waiting.isError || waiting.data.length === 0) return null;
  return (
    <SettingsCard
      title="Runs waiting on you"
      description="Your agent’s runs that failed or that you stopped. They don’t run again until you retry them. Requests from people who can ask you are on the Requests page."
    >
      <WaitingJobGroups jobs={waiting.data} />
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Who can start your agent
// ---------------------------------------------------------------------------------------------

function useTeamPrincipalOptions(teamId: string | undefined): PrincipalOptions {
  const members = useMembers(teamId);
  const roles = useRoles(teamId);
  return {
    users: members.data?.items.map((member) => member.user) ?? [],
    roles:
      roles.data?.items.map(({ id, name, color, isEveryone }) => ({
        id,
        name,
        color,
        isEveryone,
      })) ?? [],
    projectRoles: [],
  };
}

/** Who can start your agent, per team (agent access): the team defaults. */
function AgentAccessCard() {
  const access = useAgentAccess();
  return (
    <div id="who-can-start" className="scroll-mt-4">
      <SettingsCard
        title="Who can start your agent"
        description="For each team: who starts your agent without asking, and who can ask you first. Each project can override this on its Your settings page."
      >
        {access.isPending ? (
          <Skeleton className="h-24" />
        ) : access.isError ? (
          <ErrorState
            title="Couldn’t load who can start your agent"
            error={access.error}
            onRetry={() => void access.refetch()}
          />
        ) : access.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Join or create a team first: this is set per team.
          </p>
        ) : (
          <div className="grid gap-6 divide-y">
            {access.data.map((team) => (
              <TeamAccess key={team.teamId} team={team} showName={access.data.length > 1} />
            ))}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

function TeamAccess({ team, showName }: { team: TeamAgentAccess; showName: boolean }) {
  const save = useSetTeamAgentAccess();
  const options = useTeamPrincipalOptions(team.teamId);
  const [draft, setDraft] = useState<AgentAccessRules | null>(null);
  const value = draft ?? team.rules;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(team.rules);
  const submit = () =>
    save.mutate(
      { teamId: team.teamId, rules: value },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success(`Saved who can start your agent in ${team.teamName}`);
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );
  return (
    <section
      aria-label={`Who can start your agent in ${team.teamName}`}
      className="grid gap-3 pt-4 first:pt-0"
    >
      {showName ? <h3 className="text-sm font-semibold">{team.teamName}</h3> : null}
      <AgentAccessEditor
        label={
          showName ? `Who can start your agent in ${team.teamName}` : 'Who can start your agent'
        }
        value={value}
        onChange={setDraft}
        options={options}
        disabled={save.isPending}
      />
      <div className="flex items-center justify-end gap-2">
        {team.isDefault && !dirty ? (
          <span className="mr-auto text-xs text-muted-foreground">
            The default: only you start it; everyone can ask.
          </span>
        ) : null}
        {dirty ? (
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Discard
          </Button>
        ) : null}
        <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>
          {save.isPending ? <Spinner /> : null}
          Save
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

function ModelsCard() {
  const mappings = useModelMappings();
  const save = useSetModelMappings();
  const [draft, setDraft] = useState<Chain | null>(null);
  if (mappings.isPending) return <SettingsCardSkeleton rows={3} />;
  if (mappings.isError) {
    return (
      <ErrorState
        title="Couldn’t load your models"
        error={mappings.error}
        onRetry={() => void mappings.refetch()}
      />
    );
  }
  const chain = draft ?? mappings.data.default.chain;
  const dirty =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(mappings.data.default.chain);
  const submit = () =>
    // Projects' own models are edited on each project's Your settings page and kept as they are.
    save.mutate(
      { ...mappings.data, default: { ...mappings.data.default, chain } },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success('Saved your models');
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );
  return (
    <SettingsCard
      title="Models"
      description="Which harness and model run each task, by its difficulty. When a harness is out of usage (or not installed on that machine) the desktop app moves on to the next step of the chain."
      footer={
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save models
          </Button>
        </div>
      }
    >
      <div className="grid gap-5">
        <section className="grid gap-2">
          <h4 className="text-sm font-medium">Default</h4>
          <p className="text-xs text-muted-foreground">
            Every project uses it unless you give a project its own models (from the project’s menu:
            Your settings).
          </p>
          <ChainEditor
            label="Default chain"
            value={chain}
            onChange={setDraft}
            emptyText={`Uses ${chainSummary(DEFAULT_CHAIN)}`}
          />
        </section>
        <ProjectsWithModels projectIds={Object.keys(mappings.data.projects)} />
      </div>
    </SettingsCard>
  );
}

/** "Projects with their own models", each linking to its Your settings page (BAT-29). */
function ProjectsWithModels({ projectIds }: { projectIds: string[] }) {
  const teams = useMe().data?.teams ?? [];
  const projects = teams.flatMap((team) =>
    team.projects
      .filter((project) => projectIds.includes(project.id))
      .map((project) => ({ ...project, team })),
  );
  return (
    <section className="grid gap-2">
      <h4 className="text-sm font-medium">Projects with their own models</h4>
      {projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None yet. To set models for one project, open its menu: Your settings.
        </p>
      ) : (
        <ul className="grid gap-1" aria-label="Projects with their own models">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                to={`/t/${project.team.slug}/p/${project.key}/me`}
                className="text-sm hover:underline"
              >
                {project.team.name} / {project.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const count = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

const COST_HELP = `Claude Code reports what each run cost. For harnesses that don’t (Codex, Gemini CLI, …) the cost is estimated from the tokens at API list prices (as of ${MODEL_PRICES_AS_OF}), marked “≈ … est.”. Runs on a subscription have no real per-token charge: the estimate is what the same work would cost through the API. Models without a known price show “—”.`;

/**
 * BAT#25: the reported cost, "≈ $12.40 est." when some of it is estimated, "—" when nothing in
 * the row has a known price. `detail` explains what is missing.
 */
function costText(row: AgentUsageTotals): { text: string; detail: string | null } {
  const total = row.costUsd + row.costEstimatedUsd;
  const unpriced =
    row.unpricedRuns > 0
      ? `${pluralize(row.unpricedRuns, 'run')} of models without a known price not included`
      : null;
  if (total === 0 && row.unpricedRuns > 0) return { text: '—', detail: unpriced };
  if (row.costEstimatedUsd > 0 || row.unpricedRuns > 0) {
    return {
      text: `≈ ${money.format(total)} est.`,
      detail: [
        row.costEstimatedUsd > 0
          ? `${money.format(row.costEstimatedUsd)} estimated at API prices`
          : null,
        unpriced,
      ]
        .filter(Boolean)
        .join('; '),
    };
  }
  return { text: money.format(total), detail: null };
}

/** Uncached input: all input minus cache reads and writes. */
function uncachedInput(row: AgentUsageTotals): number {
  return Math.max(0, row.tokensIn - row.tokensCacheRead - row.tokensCacheWrite);
}

function StatsCard() {
  const [days, setDays] = useState(30);
  const stats = useAgentStats(days);
  const selectId = useId();
  return (
    <SettingsCard
      title="Stats"
      description="Tokens and cost of your agent’s runs, as reported by your desktop apps."
      action={
        <div className="flex items-center gap-2">
          <Label htmlFor={selectId} className="sr-only">
            Period
          </Label>
          <select
            id={selectId}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      }
    >
      {stats.isPending ? (
        <Skeleton className="h-24" />
      ) : stats.isError ? (
        <ErrorState
          title="Couldn’t load your stats"
          error={stats.error}
          onRetry={() => void stats.refetch()}
        />
      ) : stats.data.totals.jobs === 0 ? (
        <p className="text-sm text-muted-foreground">No runs in this period yet.</p>
      ) : (
        <div className="grid gap-4">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Jobs" value={count.format(stats.data.totals.jobs)} />
            <Tile
              label="Tokens"
              value={compact.format(stats.data.totals.tokensIn + stats.data.totals.tokensOut)}
              detail={`${count.format(stats.data.totals.tokensIn)} in (${count.format(stats.data.totals.tokensCacheRead)} from the cache), ${count.format(stats.data.totals.tokensOut)} out`}
            />
            <Tile
              label="Cost"
              value={costText(stats.data.totals).text}
              detail={costText(stats.data.totals).detail}
              help={COST_HELP}
            />
            <Tile label="Time" value={duration(stats.data.totals.durationMs)} />
          </dl>
          <StatsTable
            title="By harness"
            rows={stats.data.byHarness.map((row) => ({
              name: HARNESS_LABELS[row.harness as HarnessId] ?? row.harness,
              ...row,
            }))}
          />
          <StatsTable
            title="By model"
            rows={stats.data.byModel.map((row) => ({
              name: `${HARNESS_LABELS[row.harness as HarnessId] ?? row.harness} ${row.model || '(default)'}`,
              ...row,
            }))}
          />
          <StatsTable
            title="By difficulty"
            rows={stats.data.byDifficulty.map((row) => ({ name: row.difficulty, ...row }))}
          />
          <StatsTable
            title="By day"
            rows={stats.data.byDay.map((row) => ({ name: row.day, ...row }))}
          />
        </div>
      )}
    </SettingsCard>
  );
}

function Tile({
  label,
  value,
  detail = null,
  help,
}: {
  label: string;
  value: string;
  detail?: string | null;
  help?: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {help ? <HelpTip topic={label}>{help}</HelpTip> : null}
      </dt>
      <dd className="text-lg font-semibold tabular-nums" title={detail ?? undefined}>
        {value}
      </dd>
    </div>
  );
}

/** A token count, compact ("20.1M") with the exact number on hover. */
function Tokens({ value }: { value: number }) {
  return <span title={count.format(value)}>{value === 0 ? '0' : compact.format(value)}</span>;
}

const TOKEN_COLUMNS: Array<{
  label: string;
  help: string;
  value: (row: AgentUsageTotals) => number;
}> = [
  { label: 'Input', help: 'Input not read from the cache', value: uncachedInput },
  {
    label: 'Cache read',
    help: 'Input read from the prompt cache (cheaper)',
    value: (row) => row.tokensCacheRead,
  },
  {
    label: 'Cache write',
    help: 'Input written to the prompt cache',
    value: (row) => row.tokensCacheWrite,
  },
  { label: 'Output', help: 'Output, reasoning included', value: (row) => row.tokensOut },
  {
    label: 'Reasoning',
    help: 'Of the output, reasoning tokens (when the harness reports them)',
    value: (row) => row.tokensReasoning,
  },
];

function StatsTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<AgentUsageTotals & { name: string }>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="pb-1 text-left text-xs font-medium text-muted-foreground">
          {title}
        </caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Name</th>
            <th className="py-1 pr-2 text-right font-medium">Jobs</th>
            {TOKEN_COLUMNS.map((column) => (
              <th
                key={column.label}
                className="py-1 pr-2 text-right font-medium whitespace-nowrap"
                title={column.help}
              >
                {column.label}
              </th>
            ))}
            <th className="py-1 pr-2 text-right font-medium whitespace-nowrap" title={COST_HELP}>
              Cost (est.)
            </th>
            <th className="py-1 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cost = costText(row);
            return (
              <tr key={row.name} className="border-b last:border-b-0">
                <td className="py-1 pr-2">{row.name}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{count.format(row.jobs)}</td>
                {TOKEN_COLUMNS.map((column) => (
                  <td key={column.label} className="py-1 pr-2 text-right tabular-nums">
                    <Tokens value={column.value(row)} />
                  </td>
                ))}
                <td
                  className="py-1 pr-2 text-right whitespace-nowrap tabular-nums"
                  title={cost.detail ?? undefined}
                >
                  {cost.text}
                </td>
                <td className="py-1 text-right tabular-nums">{duration(row.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
