# Agents, pipelines and project permissions (design, 2026-09-27)

Agreed with the product owner (Ethan) in conversation; this is the source of truth for the
implementation waves below. Where it deviates from SPEC.md, add a dated line to DECISIONS.md.
Everything here is **optional and decoupled**: a project without rules behaves exactly as today.

## 1. Agent members

- Every human user has exactly one **agent member**: a `user` row with `kind = 'agent'` and
  `agent_owner_id = <owner id>` (humans: `kind = 'human'`, owner null). Username `<owner>-ai`
  (e.g. `ethan-ai`), display name `<Owner name> AI`, email `<id>@agents.baton.invalid`
  (verified, never mailed), no password or OAuth account: agents can never sign in on the web.
  The owner's username change renames the agent. The `-ai` suffix is reserved for agents
  (sign-up and username changes refuse it).
- The agent is created for every existing user by migration and for new users on sign-up
  (`ensureAgent(userId)` is idempotent).
- **Team membership mirrors the owner**: when the owner joins a team, the agent joins with only
  `@everyone`; when the owner leaves or is removed, the agent goes too. Admins can give the agent
  roles like any member, and can remove it (it comes back only if the owner re-joins).
- **API keys** stay owned (created, listed, revoked) by the human, but a request with a key acts as
  the **agent**: `Actor = { userId: <agent id>, ownerId: <human id>, source, key }`. Everything the
  agent writes is authored by `ethan-ai`; `via` still records the key and its harness
  (`api_key.agent_name`, "Claude") for display on hover.
- **Permission cap**: an agent's effective permissions in a team/project are its own (roles +
  project overrides) **intersected with its owner's** in the same scope. Agents are never owners.
- **Pause / kill switch**: the owner can pause their agent (`user.agent_paused_at`); team and
  project settings have "Pause all agents" (`team.agents_paused_at`, `project.agents_paused_at`).
  While paused the agent's writes are refused (`423 agents_paused`, reads still work) and it gets
  no jobs.
- **Display**: the agent is a normal member ("Ethan AI" `@ethan-ai`, an "AI" badge), its avatar is
  the harness logo of the key it used with the owner's picture as the bottom-right badge (BAT-6/8).
  History written before this change keeps showing "Claude via Ethan's MSI".
- **Notifications**: agent members never get inbox notifications; everything that would notify
  them becomes an agent **job** (§4). Owners choose how much of their agent's activity reaches
  their inbox: `user.agent_notifications = 'all' | 'needs_me' | 'none'` (default `needs_me`:
  action requests §6, and things that mention/assign the owner). This replaces BAT-6's "notify the
  actor when they used a key".
- BAT-6's `@claude`-style handles and `agent_mention` are retired: `@ethan-ai` is a normal
  username mention. `wait_for_mentions` stays as a deprecated alias of `start_listener`.

## 2. "Who" rules (principals)

One shape everywhere (assignee pools, move permissions, approvers, hand-offs, notify lists):

```ts
type Principal =
  | { type: 'user'; userId: string } // a person or an agent member
  | { type: 'role'; roleId: string; scope: 'people' | 'agents' | 'both' } // team role
  | { type: 'project_role'; roleId: string; scope: 'people' | 'agents' | 'both' }
  | { type: 'everyone'; scope: 'people' | 'agents' | 'both' };
interface PrincipalRule {
  allow: Principal[];
  deny: Principal[];
} // allow any, minus deny
```

`scope: 'agents'` of a role means the agents whose owners have the role, plus agents that hold
the role themselves. Resolver: `matchesRule(db, {teamId, projectId}, userId, rule)` and
`expandRule(...) → userIds`. Shared types in `shared/principals.ts`.

## 3. Project permissions

- Permissions split into **team-level** (ADMINISTRATOR, MANAGE_TEAM, MANAGE_ROLES, MANAGE_MEMBERS,
  CREATE_INVITES, MANAGE_INVITES, MANAGE_PROJECTS, VIEW_AUDIT_LOG, MANAGE_TRASH) — only from team
  roles — and **project-level** (VIEW_PROJECT, MANAGE_STATUSES, MANAGE_LABELS, CREATE_ISSUES,
  CREATE_TASKS, REPLY, UPDATE_TASKS, RESOLVE_ISSUES, EDIT_ANY_CONTENT, DELETE_ANY_CONTENT,
  MENTION_EVERYONE, MANAGE_PROJECT_ACCESS) — which start from team roles and can be overridden
  per project. `VIEW_PROJECT` is new and in `@everyone` by default; without it the project is
  invisible (404, left out of lists, search, dashboards).
- **Project roles**: `project_role` (per project; name, slug, color, position) with members
  (people or agents). Managed with `MANAGE_PROJECT_ACCESS` (or team MANAGE_PROJECTS/admin).
- **Overrides**: `project_permission_override (project, subject: team_role | project_role | user,
allow[], deny[])`. Effective project permissions, Discord-style: team role permissions (project
  -level subset) → apply team-role and project-role overrides (all denies, then all allows) →
  apply the user's own override (deny, then allow). Team owner and ADMINISTRATOR bypass. Agents:
  then intersect with the owner's result.
- Default change: `@everyone` no longer has `CREATE_INVITES` (new teams, and a migration removes it
  from existing `@everyone` roles).

## 4. Listener and jobs (agents at work)

- `agent_job`: `(agent, team, project, kind, target (task|issue|reply), trigger reply, payload,
status pending|claimed|done|cancelled, session)`. Kinds: `mention` (agent's
  username in a reply/task/issue body), `assigned` (task assigned to the agent), `pool` (task
  entered a stage whose hand-off pool includes the agent; first claim wins, the task is assigned to
  the claimer and the others' pool jobs are cancelled), `thread_reply` (a reply in a thread the
  agent authored, replied in or is assigned to, by someone else), `approval` (the agent may
  approve the task's current stage), `action_result` (§6).
- MCP `start_listener { projects: [KEY…] (required), timeoutSeconds ≤ 110 }`: registers or
  refreshes the session (`agent_session`: agent, key, projects, last_seen) for **those projects
  only**, then returns the pending jobs it can claim at once, or waits up to the timeout for the
  first one. Returned jobs are **claimed atomically** by this session and held until it completes or
  releases them — no timers (like task claims since 2026-09-27); only when the session disappears
  (not seen for 90 s) are its claimed jobs put back for another session. The agent's harness
  spawns a subagent per job and loops. `complete_job { jobId, agreeDone? }`, `release_job { jobId }`.
  Jobs of other projects wait until a listener for them runs.
- Two sessions of one agent never get the same job; two different agents mentioned together each
  get their own job (both answer; both may approve if the rule allows).
- **Loop guard**: no `mention`/`thread_reply` jobs are created from a reply when the thread's last 5
  replies are all by agents; a human reply resets it.
- **Done handshake**: `add_reply { closing: true }` means "no further discussion needed at this
  time". A job triggered by another agent's closing reply carries `closing: true`; if the receiving
  agent agrees it calls `complete_job { agreeDone: true }` **without replying**, the server records
  an activity row "ethan-ai and caden-ai agreed nothing more is needed", and no agent jobs come from
  agent replies in that thread until a human replies. Tool descriptions explain this.
- **Presence**: an agent is online while a listener session was seen in the last 90 s; a person is
  online while they have a live-updates connection (SSE or long-poll) open. `GET
/api/teams/:id/presence` and a throttled `presence.changed` live event.

## 5. Pipelines (per-project stage rules)

> **BAT-25:** a project can now have several pipelines, each its own ordered set of stages and
> board (see docs/API.md "Pipelines (BAT-25)" and DECISIONS 2026-09-27). Everything below applies
> per pipeline: the next stage and the send-back stages are those of the task's pipeline.

Statuses are stages with **no hidden open/done category** (2026-09-27 "stages"): each has a name,
color, a user-chosen **icon shape** and optional rules. A new project's Open and Done are ordinary
stages (Done carries the finishing rules below); nothing depends on a stage being "done".

**Assignments belong to (task, stage)**: a task's assignees are its assignments in its current
stage; assigning edits those; other stages' assignments are history ("who held it in Development").
"Your work" (My tasks, dashboard) is every task whose current-stage assignees include you or your
roles, whatever the stage.

Every status (stage) gets optional rules (`status` columns, JSON where noted):

- `instructions` (markdown): what to do here; shown on the task and included in agent jobs.
- **On enter** — `handoff` `{ mode, rule?, statusId? }` decides the stage's assignees, with modes
  `keep` (default: the assignees the task had in this stage on an earlier visit, when it had any;
  otherwise the previous stage's), `nobody` (no assignees here), `specific` (assign the users of
  `rule`), `pool` (nobody; anyone matching `rule` may claim — people see a Claim button, agents get
  `pool` jobs), `round_robin` / `least_busy` (among `rule`'s users), `author`, `mover`,
  `stage_holder` (whoever held the task in `statusId`: its assignments there); `notify` (a
  PrincipalRule; notified, not assigned); `onEnter` `{ resolveIssues, releaseClaim, notifyAuthor }`
  (resolve the issues the task fixes, release its claim, tell the author and the previous holders it
  reached the stage; all off by default).
- **While here** — `blocksDependents` (default on: its tasks still block the tasks waiting on
  them; off: they count as completed, `completedAt`) and `claimable` (default on: `claim_next_task`
  may pick its tasks and `claim_task` works without moving them).
- **Starting here** (BAT-34) — `allowCreate` ("New tasks can start here"; off for a new stage): only
  such stages take new tasks (the board column's +, the New task form's status picker, `statusId`
  on create). Without a stage, a task starts in the pipeline's default stage when it allows it, else
  in its first stage that does; with none, creating fails with a message saying so, and the board
  and the stage settings warn. Making a stage the default turns it on.
- The seeded Done (and every former done status, by migration 0012) is: hand-off `nobody`, all
  three `onEnter` effects, `blocksDependents` and `claimable` off, icon `check-circle`; the seeded
  Open (the default) has `allowCreate` on, Done off.
- **To leave (forward)** — `exit_criteria` `[{ id, text }]` (each needs evidence text: the mover
  supplies it, e.g. `move_task { evidence: { <id>: "…" } }`; saved per task/stage and **locked**
  once the task leaves the stage); `move_rule` (PrincipalRule; who may move it out); `approvals`
  `{ count, rule, dismissOnChange }` (Approve / Request changes in the task thread; each person or
  agent counts once; stale approvals dismissed on edits when `dismissOnChange`); `auto_advance`
  (move by itself as soon as criteria + approvals are satisfied); `next_status_id` (default: the
  next column).
- **Strict moves (BAT-27)**, like invisible arrows, in every project: **forward** only to the next
  stage (`next_status_id`, else the next column), through the leave rules above; no skipping (a
  stage to skip is configured out with `next_status_id`). **Back** only to the earlier stages checked
  in the stage's `send_back_to` ("Can move to" in the stage dialog; empty: it can't send back), with
  no approvals or evidence needed but always a **reason**, by whoever may move it on or approve the
  stage. Request changes sends it back with the reviewer's comment as the reason (the reviewer picks
  the stage when several are checked; default the nearest). The reason is stored on the new visit
  (`task_stage_entry.return_reason`, `returned_by_id`, `returned_from_status_id`), posted in the
  thread ("Sent back from Human Review: …"), audited as `task.moved` with `meta.direction: 'back'`,
  shown on the task page and put at the top of the agent's next job brief ("Sent back because";
  `payload.returnReason`). Coming back to a stage starts a fresh review: its earlier approvals are
  dismissed and its evidence archived (both shown as previous visits).
- The last stage simply has no next stage; its hand-off can assign back to the author or notify.
- **Admin override**: team owner/ADMINISTRATOR can force a move past any rule, with a reason
  (logged as `task.forced`).
- Rule edits apply to tasks the next time they move. Deleting a stage with tasks asks where to put
  them (existing behaviour).
- **Cards show what blocks them**: "Approvals 1/2", "Criteria 2/3", "Claimable".
- **Copy pipeline** from another project you can manage: copies statuses and all rules; principals
  that don't exist in the target team are flagged for re-picking, never silently dropped.
- MCP: `get_task` includes the stage's instructions, criteria (with evidence), approvals status,
  what is missing to move on, `canMoveTo { forward, back }` and `returnReason`; `move_task` accepts
  `evidence` and needs `reason` to send back; `approve_task { task, decision, comment?, sendBackTo? }`;
  pool tasks are claimed with `claim_task`.
- Rollout data (after deploy, by the lead, **not** Caden's projects): BAT's In-Review needs
  1 approval from people (agents denied).

## 6. Human sign-off for dangerous actions

Destructive operations requested by an agent (delete task/issue/project/team/status/label, remove
member, revoke invite, empty trash) create an `agent_action_request` instead of running: the owner
gets a `needs_me` notification with Approve / Deny; on approve the server runs it **as the agent**
(re-checking permissions) and the agent gets an `action_result` job. The MCP tools return
`{ pendingApproval: true, requestId }`. Team setting "Agents need human sign-off for destructive
actions" (default on).

## 7. Members tab

Team page tab listing members like Discord: sections per hoisted role (highest role first), each
split "Online — n" / "Offline — n", people and agents together (agents with the AI badge and their
owner), presence dots from §4, updating live.

## 8. Desktop app (automatic agents, BAT-24)

The Baton desktop app (`desktop/`, Electron) listens for an agent member's jobs with plain code,
so no tokens are spent while idle, and runs each job in a fresh headless session of the person's
own harness (Claude Code `claude -p`, Codex `codex exec`, Gemini CLI, Cursor CLI, opencode), in
the folder they mapped to the job's project, with their own settings, skills, plugins and MCP
servers (the Baton MCP is added only when missing). Web-only users keep `start_listener` as a
manual fallback.

- **Runners.** The app on a machine is a runner: an `agent_session` of kind `runner`
  (`machine_id`, `machine_name`, `harnesses`, `running`). It registers, heartbeats and long-polls
  `jobs/next`, which claims jobs atomically for the projects mapped there; a runner not seen for
  90 s is swept like a listener session and its claimed jobs return to the queue. Runners count
  for presence; the Members tab shows them ("Ethan's desktop — 1 job").
- **Whose jobs run.** `agent_job.triggered_by_id` records who caused a job. Jobs the owner (or
  their agent, or the system) caused run by themselves; by default others wait under "Needs your
  OK" (`needs_ok`) until the owner says Approve or Decline. The owner can widen it to anyone or to
  a who-rule. Manual listeners still get every job.
- **Stopped runs (BAT#22, BAT#23).** A run that fails or that the owner kills is held
  (`agent_job.held_at`) under "Stopped runs", apart from others' jobs, with why it stopped (the
  harness's last error, killed by you, out of usage) and Retry / Trash. When a run ends the app
  reports its outcome, its last error and the tail of its output (the last 200 lines, 64 KB) with
  the usage; Baton keeps them on the job (`run_outcome`, `run_error`, `run_output`) so the web
  shows them too ("Show output"), and each usage row keeps its run's error, so the chain editors
  show "Last run failed: …" next to a model the harness rejected. The full log stays on the
  computer.
- **Cleared jobs (BAT#29).** A held or waiting job whose item no longer needs it — its task
  finished (a stage that doesn't block dependents) or was deleted, its issue was resolved or
  deleted, the task left the stage the job was for, or an `assigned` job's agent is no longer
  assigned — is cancelled with `cleared_at` / `cleared_reason` when that happens (stage entry,
  resolve, delete, a finished run, and a 5-minute sweep for the rest). It shows muted under
  "Cleared — task finished" with only Open for 24 h, then drops out of the list.
- **Models (direct choice; difficulty was removed 2026-09-29).** Each person has an account
  default chain of harness + model + effort and optional per-project defaults (the project's
  "Your settings"). Whoever starts a run may suggest a model (a reply's "Suggest model", MCP
  `add_reply` `suggestModel`), and a stage may suggest one ("Planning → Opus",
  `rules.suggestedModel`); they are only suggestions. Resolution (`shared/agentChains.ts`
  `resolveJobModel`): the model chosen when approving a request, else the requester's suggestion
  when one of the owner's computers has it, else the stage's, else the owner's project default,
  else their account default; a suggestion runs first with the default after it. The app skips
  harnesses it doesn't have or that are out of usage until their reset, falling back along the
  chain. Every run shows what it ran with (harness · model · effort).
- **Briefs and sessions.** For each job the app reads a brief: a compact prompt (task, stage
  instructions, criteria, approvals, what's missing, the trigger and latest replies, the job and
  the rules), the chain, and the harness session to resume for that task on that machine. One
  process per job; a follow-up job on the same task resumes the same harness thread. A follow-up
  (`thread_reply`, `mention`) goes first to the harness that has been working on the item: its
  stored session there, else the harness of the agent's last write on it (BAT#28). A run's
  session is also linked to the tasks it created or replied in (from its Baton tool calls), so a
  reply on a task Claude Code opened resumes that Claude Code session.
- **One session per item (BAT#31).** A job about an item a job running on the same computer
  already works on doesn't start a second process: its message goes into the running session.
  Claude Code takes it mid-run (streaming input: read after the current tool call, as typing into
  an interactive session); harnesses without mid-run input get it as soon as the run ends, by
  resuming the same session with every queued message in one prompt. The merged job is completed
  once the session has the message (`deliveredTo`); if the running job is killed first, it is
  released and runs on its own. Running agents shows "1 message delivered" / "1 queued for next
  turn".
- **Out of usage (BAT#30).** Only the harness's own error signal counts (its error events, or
  stderr of a run that failed), never the agent's messages, command output or file contents; a run
  that succeeded never is. The limit is stored per harness on the computer until the reset it
  names (else an hour). Wherever a job waits on usage the app shows "Out of usage until HH:MM
  (harness)" with Retry now (that attempt ignores the stored limits; for a held job, its next
  claim here) and Clear usage limit (also on the Harnesses page); Kill stops a waiting job and
  holds it. Codex's "Full auto" is its workspace-write sandbox with network access
  (`-c sandbox_workspace_write.network_access=true`); it can't write outside the project folder.
- **Usage.** Completing, releasing or killing a job reports each harness run's usage; the stats
  page sums it by day, harness, model, level and outcome. The global pause is the owner's agent
  pause. BAT#25: usage separates input, cache reads, cache writes, output and reasoning tokens,
  and records the model the harness reported (Claude Code's init event), falling back to the
  chain's text; models are grouped by a canonical id. Costs are the harness's own when it reports
  one (Claude Code); otherwise an estimated API cost from a dated price table in
  `shared/modelPrices.ts` ("≈ $12.40 est.", with a tooltip: subscription usage has no real
  per-token charge), and "—" for models without a known price.

## Waves

1. Wave 1 (parallel): **A** agent members (§1) · **B** project permissions + principals resolver +
   invite default (§2, §3).
2. Wave 2 (parallel, on the merged wave 1): **C** listener/jobs/presence/handshake/loop guard (§4)
   · **D** pipelines + approvals (§5) · **E** dangerous-action requests (§6) · **F** members tab (§7).
3. Integrate, full e2e, deploy, apply the BAT In-Review rule.
