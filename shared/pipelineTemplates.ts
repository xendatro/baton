import { DEFAULT_STATUSES, FINISHED_STAGE_RULES, type StatusIconShape } from './constants';
import type { StageRules } from './schemas/pipelines';

/**
 * Pipeline templates (2026-09-29): the stages a new pipeline (or a new project's first one) starts
 * with. Principals stay generic (every person of the team), so a template works in any team; the
 * stages that name nobody yet say so in `setup`. Every stage can send tasks back to every earlier
 * one, as for the plain default.
 */

export const PIPELINE_TEMPLATE_IDS = ['simple', 'ai_loop', 'bug_triage'] as const;
export type PipelineTemplateId = (typeof PIPELINE_TEMPLATE_IDS)[number];
export const DEFAULT_PIPELINE_TEMPLATE: PipelineTemplateId = 'simple';

export interface PipelineTemplateStage {
  name: string;
  color: string;
  icon: StatusIconShape;
  isDefault: boolean;
  /** Rules besides the plain defaults (`allowCreate` defaults to `isDefault`). */
  rules: Partial<StageRules> | null;
}

export interface PipelineTemplate {
  id: PipelineTemplateId;
  name: string;
  /** One line under the name. */
  description: string;
  stages: readonly PipelineTemplateStage[];
  /** What to set after creating it, in words (shown by the New pipeline dialog). */
  setup: string | null;
}

const EVERY_PERSON = { allow: [{ type: 'everyone' as const, scope: 'people' as const }], deny: [] };

const FINISHED: Partial<StageRules> = {
  handoff: FINISHED_STAGE_RULES.handoff,
  onEnter: FINISHED_STAGE_RULES.onEnter,
  blocksDependents: FINISHED_STAGE_RULES.blocksDependents,
  claimable: FINISHED_STAGE_RULES.claimable,
};

export const PIPELINE_TEMPLATES: Readonly<Record<PipelineTemplateId, PipelineTemplate>> = {
  simple: {
    id: 'simple',
    name: 'Simple board',
    description: 'Plain columns you move by hand. Nothing is gated or assigned for you.',
    stages: DEFAULT_STATUSES,
    setup: null,
  },
  ai_loop: {
    id: 'ai_loop',
    name: 'AI loop',
    description:
      'An agent plans and builds with clear instructions; a person approves the result at Review.',
    setup: 'Pick the agents for Plan and Build (click a stage, then “Should an agent do this?”).',
    stages: [
      {
        name: 'Plan',
        color: '#6366f1',
        icon: 'dashed-circle',
        isDefault: true,
        rules: {
          allowCreate: true,
          instructions: [
            'Read the task and the code it touches, then write a short plan:',
            '',
            '- the steps, in order',
            '- the files you expect to change',
            '- how you will test it',
            '',
            'Ask in the replies if anything is unclear before you start building.',
          ].join('\n'),
          exitCriteria: [{ id: 'plan', text: 'The plan: steps, files to change and how to test' }],
        },
      },
      {
        name: 'Build',
        color: '#f59e0b',
        icon: 'half-circle',
        isDefault: false,
        rules: {
          instructions: [
            'Follow the plan from the previous stage. Keep the change small and focused.',
            '',
            '- Write or update tests for what you change and run them.',
            '- Summarize what changed and link the commit or pull request.',
            '- If you were sent back from Review, address every comment first.',
          ].join('\n'),
          exitCriteria: [
            { id: 'tests', text: 'Tests pass (say which ones you ran)' },
            { id: 'summary', text: 'Summary of the change with a link' },
          ],
        },
      },
      {
        name: 'Review',
        color: '#8b5cf6',
        icon: 'dot-circle',
        isDefault: false,
        rules: {
          instructions:
            'Check the change against the plan and the task. Approve it, or request changes with what to fix: it goes back to Build.',
          approvals: { count: 1, rule: EVERY_PERSON, dismissOnChange: true },
        },
      },
      { name: 'Done', color: '#22c55e', icon: 'check-circle', isDefault: false, rules: FINISHED },
    ],
  },
  bug_triage: {
    id: 'bug_triage',
    name: 'Bug triage',
    description: 'Bugs are reported, triaged, fixed and verified before they close.',
    setup: null,
    stages: [
      {
        name: 'Reported',
        color: '#ef4444',
        icon: 'dashed-circle',
        isDefault: true,
        rules: {
          allowCreate: true,
          instructions:
            'Describe the bug: what you did, what you expected and what happened instead. Add screenshots or logs if you have them.',
        },
      },
      {
        name: 'Triaged',
        color: '#f59e0b',
        icon: 'circle',
        isDefault: false,
        rules: {
          instructions: 'Reproduce the bug and decide how urgent it is.',
          exitCriteria: [
            { id: 'repro', text: 'Steps to reproduce' },
            { id: 'severity', text: 'Severity and who is affected' },
          ],
        },
      },
      {
        name: 'Fixing',
        color: '#3b82f6',
        icon: 'half-circle',
        isDefault: false,
        rules: {
          instructions:
            'Fix the cause, not only the symptom, and add a test that would have caught it.',
          exitCriteria: [{ id: 'fix', text: 'Link to the fix and the test that covers it' }],
        },
      },
      {
        name: 'Verifying',
        color: '#8b5cf6',
        icon: 'dot-circle',
        isDefault: false,
        rules: {
          instructions:
            'Follow the steps to reproduce on the fixed version and confirm it is gone.',
          exitCriteria: [{ id: 'verified', text: 'Where and how it was verified' }],
        },
      },
      { name: 'Closed', color: '#22c55e', icon: 'check-circle', isDefault: false, rules: FINISHED },
    ],
  },
};

export const PIPELINE_TEMPLATE_LIST: readonly PipelineTemplate[] = PIPELINE_TEMPLATE_IDS.map(
  (id) => PIPELINE_TEMPLATES[id],
);
