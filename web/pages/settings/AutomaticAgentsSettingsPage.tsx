import { DownloadIcon, MonitorIcon, PauseIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  DEFAULT_CHAIN,
  HARNESS_LABELS,
  type AgentUsageTotals,
  type Chain,
  type HarnessId,
  type JobSourceMode,
} from '@shared/schemas/agentRunner';
import type { PrincipalRule } from '@shared/principals';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { HelpTip } from '@web/components/common/HelpTip';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { PrincipalRulePicker } from '@web/components/pickers/PrincipalRulePicker';
import { EMPTY_RULE, type PrincipalOptions } from '@web/components/pickers/principals';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Skeleton } from '@web/components/ui/skeleton';
import { Switch } from '@web/components/ui/switch';
import { errorMessage } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { isDesktopApp } from '@web/lib/desktop';
import { pluralize } from '@web/lib/format';
import { useMembers, useRoles } from '../teams/api';
import {
  useAgentStats,
  useJobSources,
  useModelMappings,
  useRunners,
  useSetJobSources,
  useSetModelMappings,
  useWaitingJobs,
} from './automaticAgentsQueries';
import { ChainEditor } from './ChainEditor';
import { WaitingJobsList } from './WaitingJobs';
import { chainSummary } from './chainSummary';
import { useAgentSettings, useUpdateAgentSettings } from './queries';
import { SettingsCard, SettingsCardSkeleton, SettingsPage } from './SettingsCard';

/**
 * Settings → Automatic agents (BAT-24): the Baton desktop app runs your agent's jobs in your own
 * harness (Claude Code, Codex, …). Here: your desktop apps, jobs waiting for your OK, whose jobs
 * run by themselves, your default models (each project's own are on its Your settings page,
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
      <JobSourcesCard />
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
      title={`Waiting for your OK (${waiting.data.length})`}
      description="Jobs you stopped, and jobs from people outside “Whose jobs run”. They only run when you say so."
    >
      <WaitingJobsList jobs={waiting.data} />
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Whose jobs run
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

function JobSourcesCard() {
  const sources = useJobSources();
  const save = useSetJobSources();
  const teams = useMe().data?.teams ?? [];
  const [draft, setDraft] = useState<{ mode: JobSourceMode; rule: PrincipalRule | null } | null>(
    null,
  );
  const [teamId, setTeamId] = useState<string | undefined>(undefined);
  const options = useTeamPrincipalOptions(teamId ?? teams[0]?.id);
  const selectId = useId();
  if (sources.isPending) return <SettingsCardSkeleton rows={2} />;
  if (sources.isError) return null;
  const value = draft ?? sources.data;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(sources.data);
  const submit = () =>
    save.mutate(
      { mode: value.mode, rule: value.mode === 'custom' ? (value.rule ?? EMPTY_RULE) : null },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success('Saved whose jobs run');
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );
  return (
    <SettingsCard
      title="Whose jobs run"
      description="Jobs from anyone else wait under “Waiting for your OK” and never run by themselves."
      footer={
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save
          </Button>
        </div>
      }
    >
      <RadioGroup
        value={value.mode}
        onValueChange={(mode) => setDraft({ mode: mode as JobSourceMode, rule: value.rule })}
        aria-label="Whose jobs run"
        className="gap-2"
      >
        <Choice
          value="me"
          label="Only jobs I trigger"
          help="Your own mentions, assignments and moves of your agent."
        />
        <Choice value="anyone" label="Anyone who can mention or assign my agent" />
        <Choice value="custom" label="Only these people…" />
      </RadioGroup>
      {value.mode === 'custom' ? (
        <div className="mt-3 grid gap-2 rounded-lg border p-3">
          {teams.length > 1 ? (
            <div className="flex items-center gap-2">
              <Label htmlFor={selectId} className="text-xs">
                Pick from
              </Label>
              <select
                id={selectId}
                value={teamId ?? teams[0]?.id ?? ''}
                onChange={(event) => setTeamId(event.target.value)}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <PrincipalRulePicker
            label="Whose jobs run"
            value={value.rule ?? EMPTY_RULE}
            onChange={(rule) => setDraft({ mode: 'custom', rule })}
            options={options}
          />
        </div>
      ) : null}
    </SettingsCard>
  );
}

function Choice({ value, label, help }: { value: string; label: string; help?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem id={id} value={value} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      {help ? <HelpTip topic={label}>{help}</HelpTip> : null}
    </div>
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

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

function StatsCard() {
  const [days, setDays] = useState(30);
  const stats = useAgentStats(days);
  const selectId = useId();
  return (
    <SettingsCard
      title="Stats"
      description="What your agent’s runs cost, as reported by your desktop apps."
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
              value={count.format(stats.data.totals.tokensIn + stats.data.totals.tokensOut)}
            />
            <Tile label="Cost" value={money.format(stats.data.totals.costUsd)} />
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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

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
            <th className="py-1 pr-2 text-right font-medium">Tokens</th>
            <th className="py-1 pr-2 text-right font-medium">Cost</th>
            <th className="py-1 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-b last:border-b-0">
              <td className="py-1 pr-2">{row.name}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{count.format(row.jobs)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">
                {count.format(row.tokensIn + row.tokensOut)}
              </td>
              <td className="py-1 pr-2 text-right tabular-nums">{money.format(row.costUsd)}</td>
              <td className="py-1 text-right tabular-nums">{duration(row.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
