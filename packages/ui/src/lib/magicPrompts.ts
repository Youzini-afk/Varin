import { runtimeFetch } from '@varin/application-client';

export type MagicPromptId =
  | 'git.commit.generate.visible'
  | 'git.commit.generate.instructions'
  | 'git.pr.generate.visible'
  | 'git.pr.generate.instructions'
  | 'git.conflict.resolve.visible'
  | 'git.conflict.resolve.instructions'
  | 'git.integrate.cherrypick.resolve.visible'
  | 'git.integrate.cherrypick.resolve.instructions'
  | 'github.pr.review.visible'
  | 'github.pr.review.instructions'
  | 'github.issue.review.visible'
  | 'github.issue.review.instructions'
  | 'github.pr.checks.review.visible'
  | 'github.pr.checks.review.instructions'
  | 'github.pr.comments.review.visible'
  | 'github.pr.comments.review.instructions'
  | 'github.pr.comment.single.visible'
  | 'github.pr.comment.single.instructions'
  | 'plan.todo.visible'
  | 'plan.todo.instructions'
  | 'plan.improve.visible'
  | 'plan.improve.instructions'
  | 'plan.implement.visible'
  | 'plan.implement.instructions'
  | 'session.summary.visible'
  | 'session.summary.instructions'
  | 'session.review.visible'
  | 'session.review.instructions'
  | 'session.reviewHandoff.visible'
  | 'session.reviewHandoff.instructions'
  | 'session.reviewSession.visible'
  | 'session.reviewSessionWithoutHandoff.visible'
  | 'session.reviewFeedbackToImplementer.visible'
  | 'session.implementationResponseToReviewer.visible'
  | 'session.plan.visible'
  | 'session.plan.instructions'
  | 'session.craftGoal.visible'
  | 'session.craftGoal.instructions'
  | 'session.scheduleTask.visible'
  | 'session.scheduleTask.instructions'
  | 'session.catchup.visible'
  | 'session.catchup.instructions'
  | 'session.debug.visible'
  | 'session.debug.instructions'
  | 'session.weigh.visible'
  | 'session.weigh.instructions'
  | 'session.explore.visible'
  | 'session.explore.instructions'
  | 'session.fusion.visible'
  | 'session.fusion.instructions';

export interface MagicPromptDefinition {
  id: MagicPromptId;
  title: string;
  description: string;
  group: 'Git' | 'GitHub' | 'Planning' | 'Session';
  template: string;
  placeholders?: Array<{ key: string; description: string }>;
}

export interface MagicPromptOverridesPayload {
  version: number;
  overrides: Record<string, string>;
}

const API_ENDPOINT = '/api/magic-prompts';

const MAGIC_PROMPT_DEFINITIONS: readonly MagicPromptDefinition[] = [
  {
    id: 'git.commit.generate.visible',
    title: 'Commit Generation Visible Prompt',
    group: 'Git',
    description: 'Visible user message for commit message generation.',
    template: 'Draft a Conventional Commit message from the diffs of the selected files.',
  },
  {
    id: 'git.commit.generate.instructions',
    title: 'Commit Generation Instructions',
    group: 'Git',
    description: 'Hidden instructions for commit message generation.',
    placeholders: [
      { key: 'selected_files', description: 'Bullet list of currently selected file paths.' },
    ],
    template: `Return JSON with "subject" (string) and "highlights" (up to three strings).

Selected files:
{{selected_files}}`,
  },
  {
    id: 'git.pr.generate.visible',
    title: 'PR Generation Visible Prompt',
    group: 'Git',
    description: 'Visible user message for PR title/body generation.',
    template: 'Draft a pull request title and description for these changes.',
  },
  {
    id: 'git.pr.generate.instructions',
    title: 'PR Generation Instructions',
    group: 'Git',
    description: 'Hidden instructions for PR title/body generation.',
    placeholders: [
      { key: 'base_branch', description: 'Base branch name.' },
      { key: 'head_branch', description: 'Head branch name.' },
      { key: 'commits', description: 'Bullet list of commits in base...head.' },
      { key: 'changed_files', description: 'Bullet list of changed files in base...head.' },
      { key: 'additional_context_block', description: 'Optional Additional context block (already formatted).' },
    ],
    template: `Return JSON with "title" and "body" string fields. The body is Markdown.

Base branch: {{base_branch}}
Head branch: {{head_branch}}

Commits in range (base...head):
{{commits}}

Files changed across these commits:
{{changed_files}}{{additional_context_block}}`,
  },
  {
    id: 'github.pr.review.visible',
    title: 'PR Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message when creating PR review requests from GitHub context.',
    placeholders: [
      { key: 'pr_number', description: 'Pull request number.' },
    ],
    template: 'Review this pull request #{{pr_number}} using the provided PR context',
  },
  {
    id: 'github.pr.review.instructions',
    title: 'PR Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions attached when generating a PR review response.',
    template: 'Assess whether the pull request achieves its intent and identify issues introduced by its changes. The working tree may differ from the PR; use the supplied diff to identify the changes and relevant repository code to explain your findings.',
  },
  {
    id: 'github.issue.review.visible',
    title: 'Issue Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message when creating issue review requests from GitHub context.',
    placeholders: [
      { key: 'issue_number', description: 'Issue number.' },
    ],
    template: 'Review this issue #{{issue_number}} using the provided issue context',
  },
  {
    id: 'github.issue.review.instructions',
    title: 'Issue Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions attached when generating an issue review response.',
    template: 'Assess the issue using the supplied description, discussion, and relevant project context. Explain possible ways to address it.',
  },
  {
    id: 'github.pr.checks.review.visible',
    title: 'PR Failed Checks Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for PR failed checks analysis.',
    template: 'Review these failed PR checks and suggest fixes.',
  },
  {
    id: 'github.pr.checks.review.instructions',
    title: 'PR Failed Checks Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for PR failed checks analysis.',
    template: 'Diagnose the failures using the attached check results, logs, annotations, and relevant code.',
  },
  {
    id: 'github.pr.comments.review.visible',
    title: 'PR Comments Review Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for PR comments analysis.',
    template: 'Review these PR comments and suggest how to address them.',
  },
  {
    id: 'github.pr.comments.review.instructions',
    title: 'PR Comments Review Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for PR comments analysis.',
    template: 'Evaluate the attached review comments against the changed code and the pull request\'s intent.',
  },
  {
    id: 'github.pr.comment.single.visible',
    title: 'Single PR Comment Visible Prompt',
    group: 'GitHub',
    description: 'Visible user message for single PR comment analysis.',
    template: 'Review this PR comment and suggest how to address it.',
  },
  {
    id: 'github.pr.comment.single.instructions',
    title: 'Single PR Comment Instructions',
    group: 'GitHub',
    description: 'Hidden instructions for single PR comment analysis.',
    template: 'Assess the attached comment in the context of the relevant code and the pull request\'s intent.',
  },
  {
    id: 'git.conflict.resolve.visible',
    title: 'Merge/Rebase Conflict Visible Prompt',
    group: 'Git',
    description: 'Visible user message for merge/rebase conflict resolution help.',
    placeholders: [
      { key: 'operation_label', description: 'Operation label in lower-case (merge/rebase).' },
      { key: 'head_ref', description: 'Head reference for preserving intent.' },
    ],
    template: 'Resolve the {{operation_label}} conflicts, preserving the intent of the changes from {{head_ref}}.',
  },
  {
    id: 'git.conflict.resolve.instructions',
    title: 'Merge/Rebase Conflict Instructions',
    group: 'Git',
    description: 'Hidden instructions for merge/rebase conflict resolution help.',
    placeholders: [
      { key: 'operation_label', description: 'Operation label in lower-case (merge/rebase).' },
      { key: 'directory', description: 'Repository directory path.' },
      { key: 'operation', description: 'Operation name.' },
      { key: 'head_info', description: 'Head metadata if available.' },
      { key: 'continue_cmd', description: 'Command to continue operation.' },
    ],
    template: `Git {{operation_label}} is in progress with conflicts.

Directory: {{directory}}
Operation: {{operation}}
Head: {{head_info}}
Command to continue after resolving and staging: {{continue_cmd}}`,
  },
  {
    id: 'git.integrate.cherrypick.resolve.visible',
    title: 'Cherry-pick Conflict Visible Prompt',
    group: 'Git',
    description: 'Visible user message for cherry-pick conflict resolution help.',
    placeholders: [
      { key: 'current_commit', description: 'Current commit hash being applied.' },
      { key: 'target_branch', description: 'Target branch name.' },
    ],
    template: 'Resolve cherry-pick conflicts, stage the resolved files, and continue the cherry-pick. Keep intent of commit {{current_commit}} onto branch {{target_branch}}.',
  },
  {
    id: 'git.integrate.cherrypick.resolve.instructions',
    title: 'Cherry-pick Conflict Instructions',
    group: 'Git',
    description: 'Hidden instructions for cherry-pick conflict resolution help.',
    placeholders: [
      { key: 'repo_root', description: 'Repository root path.' },
      { key: 'temp_worktree_path', description: 'Temporary worktree path.' },
      { key: 'source_branch', description: 'Source branch name.' },
      { key: 'target_branch', description: 'Target branch name.' },
      { key: 'current_commit', description: 'Current commit hash being applied.' },
    ],
    template: `The cherry-pick is in progress with conflicts in this worktree: {{temp_worktree_path}}

Repository: {{repo_root}}
Source branch: {{source_branch}}
Target branch: {{target_branch}}
Current commit: {{current_commit}}
Command to continue after resolving and staging: git cherry-pick --continue`,
  },
  {
    id: 'plan.todo.visible',
    title: 'Todo Planning Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a todo into a new planning session.',
    placeholders: [
      { key: 'todo_text', description: 'Todo text selected by the user.' },
    ],
    template: '{{todo_text}}',
  },
  {
    id: 'plan.todo.instructions',
    title: 'Todo Planning Instructions',
    group: 'Planning',
    description: 'Hidden instructions for sending a project todo into a new planning session.',
    placeholders: [
      { key: 'todo_text', description: 'Todo text selected by the user.' },
    ],
    template: `Prepare an implementation plan for this project todo using the current project context:

{{todo_text}}`,
  },
  {
    id: 'plan.improve.visible',
    title: 'Improve Plan Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a saved plan into an improve flow.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
    ],
    template: 'Improve this plan: {{plan_title}}',
  },
  {
    id: 'plan.improve.instructions',
    title: 'Improve Plan Instructions',
    group: 'Planning',
    description: 'Hidden instructions for improving a saved plan from project context.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
      { key: 'plan_path', description: 'Absolute path to the saved plan file.' },
    ],
    template: 'Improve the plan in {{plan_path}} ({{plan_title}}) using the current project context.',
  },
  {
    id: 'plan.implement.visible',
    title: 'Implement Plan Visible Prompt',
    group: 'Planning',
    description: 'Visible user message when sending a saved plan into an implement flow.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
    ],
    template: 'Implement this plan: {{plan_title}}',
  },
  {
    id: 'plan.implement.instructions',
    title: 'Implement Plan Instructions',
    group: 'Planning',
    description: 'Hidden instructions for implementing a saved plan from project context.',
    placeholders: [
      { key: 'plan_title', description: 'Current plan title.' },
      { key: 'plan_path', description: 'Absolute path to the saved plan file.' },
    ],
    template: 'Implement the plan in {{plan_path}} ({{plan_title}}), taking the current project state into account.',
  },
  {
    id: 'session.summary.visible',
    title: 'Session Summary Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /summary command.',
    placeholders: [
      { key: 'topic_line', description: 'Pre-formatted topic clause (e.g. " focused on: <topic>") or empty string.' },
    ],
    template: 'Summarize this session{{topic_line}}.',
  },
  {
    id: 'session.summary.instructions',
    title: 'Session Summary Instructions',
    group: 'Session',
    description: 'Instructions for summarizing the session for continuity.',
    placeholders: [
      { key: 'topic_block', description: 'Pre-formatted topic focus paragraph, or empty string when no topic hint was given.' },
    ],
    template: `Summarize the context needed to continue this work, including the user's goal, progress, decisions, and relevant references.

{{topic_block}}`,
  },
  {
    id: 'session.review.visible',
    title: 'Workspace Review Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /workspace-review command.',
    template: 'Review the changes made in this workspace.',
  },
  {
    id: 'session.review.instructions',
    title: 'Workspace Review Instructions',
    group: 'Session',
    description: 'Instructions for reviewing the current workspace changes.',
    template: 'Assess the workspace changes against the intended outcome and relevant project context. Explain any issues you find with references to the affected code.',
  },
  {
    id: 'session.reviewHandoff.visible',
    title: 'Review Handoff Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /handoff-review command.',
    template: 'Prepare a handoff for another agent to review this work.',
  },
  {
    id: 'session.reviewHandoff.instructions',
    title: 'Review Handoff Instructions',
    group: 'Session',
    description: 'Hidden instructions attached to the /handoff-review command. Produces a handoff for a separate review agent.',
    template: 'Varin will send this response to another agent reviewing the work. Summarize the user\'s intent, the changes, relevant decisions, validation, and anything still unresolved.',
  },
  {
    id: 'session.reviewSession.visible',
    title: 'Review Session Starter Prompt',
    group: 'Session',
    description: 'Visible user message sent to the generated review session.',
    placeholders: [
      { key: 'handoff', description: 'The generated implementation handoff.' },
    ],
    template: `Review the changes described below against the current code and the stated intent.

{{handoff}}`,
  },
  {
    id: 'session.reviewSessionWithoutHandoff.visible',
    title: 'Review Session Starter Prompt Without Handoff',
    group: 'Session',
    description: 'Visible user message sent to a generated review session when no implementation handoff is generated first.',
    template: 'Review the current workspace changes using the diff and relevant project context.',
  },
  {
    id: 'session.reviewFeedbackToImplementer.visible',
    title: 'Review Feedback Transfer Prompt',
    group: 'Session',
    description: 'Visible user message sent from a review session back to the implementing agent.',
    placeholders: [
      { key: 'review_feedback', description: 'Reviewer assistant feedback text.' },
    ],
    template: `Another agent reviewed the changes. Assess the feedback below and address the relevant findings.

{{review_feedback}}`,
  },
  {
    id: 'session.implementationResponseToReviewer.visible',
    title: 'Implementation Response Transfer Prompt',
    group: 'Session',
    description: 'Visible user message sent from the implementing agent back to the review session.',
    placeholders: [
      { key: 'implementation_response', description: 'Implementing assistant response text.' },
    ],
    template: `Recheck the work in light of the implementation response below and report any remaining issues.

{{implementation_response}}`,
  },
  {
    id: 'session.plan.visible',
    title: 'Feature Planning Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /plan-feature command.',
    template: 'Help me plan a feature.',
  },
  {
    id: 'session.plan.instructions',
    title: 'Feature Planning Instructions',
    group: 'Session',
    description: 'Instructions for planning the requested feature.',
    template: 'Develop an implementation plan from the feature request and relevant project context.',
  },
  {
    id: 'session.craftGoal.visible',
    title: 'Goal Crafting Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /craft-goal command.',
    placeholders: [
      { key: 'idea_block', description: 'Optional initial task or idea supplied after the command.' },
    ],
    template: `Help me turn an idea or task into a clear, verifiable Goal.{{idea_block}}`,
  },
  {
    id: 'session.craftGoal.instructions',
    title: 'Goal Crafting Instructions',
    group: 'Session',
    description: 'Instructions for drafting a Varin Goal objective.',
    template: 'A Varin Goal stores the objective for an ongoing run. Draft one from the user\'s task and completion criteria.',
  },
  {
    id: 'session.scheduleTask.visible',
    title: 'Scheduled Task Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /schedule-task command.',
    placeholders: [
      { key: 'idea_block', description: 'Optional initial automation idea supplied after the command.' },
    ],
    template: `Help me set up a scheduled task.{{idea_block}}`,
  },
  {
    id: 'session.scheduleTask.instructions',
    title: 'Scheduled Task Instructions',
    group: 'Session',
    description: 'Instructions for drafting a Varin scheduled task.',
    template: 'Varin scheduled tasks run a saved prompt in a new session on a chosen schedule. Draft the task instructions and schedule, including the context each run will need and the applicable timezone.',
  },
  {
    id: 'session.catchup.visible',
    title: 'Catch Up Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /catch-up command.',
    template: 'Catch me up on where this project is right now.',
  },
  {
    id: 'session.catchup.instructions',
    title: 'Catch Up Instructions',
    group: 'Session',
    description: 'Instructions for getting oriented in the current project.',
    template: 'Orient the user from the repository\'s current state, recent work, and relevant session context.',
  },
  {
    id: 'session.debug.visible',
    title: 'Debugging Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /debug command.',
    template: 'I want to debug an issue.',
  },
  {
    id: 'session.debug.instructions',
    title: 'Debugging Instructions',
    group: 'Session',
    description: 'Instructions for investigating the reported issue.',
    template: 'Investigate the reported issue using the available symptoms and project context.',
  },
  {
    id: 'session.weigh.visible',
    title: 'Weigh Options Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /weigh command.',
    template: 'Help me decide how to approach this.',
  },
  {
    id: 'session.weigh.instructions',
    title: 'Weigh Options Instructions',
    group: 'Session',
    description: 'Instructions for comparing approaches.',
    template: 'Compare approaches in light of the user\'s goal and constraints. Explain the trade-offs and your recommendation.',
  },
  {
    id: 'session.explore.visible',
    title: 'Codebase Tour Visible Prompt',
    group: 'Session',
    description: 'Visible user message sent by the /explore command.',
    template: 'Give me a high-level tour of this codebase.',
  },
  {
    id: 'session.explore.instructions',
    title: 'Codebase Tour Instructions',
    group: 'Session',
    description: 'Instructions for explaining the codebase.',
    template: 'Explain the project\'s structure, main components, and how they connect, using the actual repository context.',
  },
  {
    id: 'session.fusion.visible',
    title: 'Fusion Visible Prompt',
    group: 'Session',
    description: 'Visible user message for multi-run fusion sessions.',
    template: 'Create the best combined answer from the multi-run results.',
  },
  {
    id: 'session.fusion.instructions',
    title: 'Fusion Instructions',
    group: 'Session',
    description: 'Hidden instructions used before multi-run source outputs in fusion sessions.',
    template: `Combine the supplied results into an answer to the original task.

--- FUSION INPUTS START ---`,
  },
] as const;

const MAGIC_PROMPT_DEFINITION_BY_ID = new Map<MagicPromptId, MagicPromptDefinition>(
  MAGIC_PROMPT_DEFINITIONS.map((definition) => [definition.id, definition])
);

let cachedOverrides: Record<string, string> | null = null;
let inFlightOverridesRequest: Promise<Record<string, string>> | null = null;

const replaceTemplateVariables = (template: string, variables: Record<string, string>) => {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      return '';
    }
    return variables[key] ?? '';
  });
};

const normalizeOverridesPayload = (payload: unknown): Record<string, string> => {
  const overridesRaw = (payload as { overrides?: unknown } | null)?.overrides;
  if (!overridesRaw || typeof overridesRaw !== 'object' || Array.isArray(overridesRaw)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(overridesRaw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      continue;
    }
    result[key] = value;
  }

  return result;
};

export const fetchMagicPromptOverrides = async (): Promise<Record<string, string>> => {
  if (cachedOverrides) {
    return cachedOverrides;
  }

  if (!inFlightOverridesRequest) {
    inFlightOverridesRequest = runtimeFetch(API_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to load magic prompts');
        }
        const payload = await response.json().catch(() => ({}));
        const normalized = normalizeOverridesPayload(payload);
        cachedOverrides = normalized;
        return normalized;
      })
      .finally(() => {
        inFlightOverridesRequest = null;
      });
  }

  return inFlightOverridesRequest;
};

export const getMagicPromptDefinition = (id: MagicPromptId): MagicPromptDefinition => {
  const definition = MAGIC_PROMPT_DEFINITION_BY_ID.get(id);
  if (!definition) {
    throw new Error(`Unknown magic prompt id: ${id}`);
  }
  return definition;
};

export const getDefaultMagicPromptTemplate = (id: MagicPromptId): string => {
  return getMagicPromptDefinition(id).template;
};

const getEffectiveMagicPromptTemplate = async (id: MagicPromptId): Promise<string> => {
  const overrides = await fetchMagicPromptOverrides().catch((): Record<string, string> => ({}));
  const override = overrides[id];
  if (typeof override === 'string') {
    return override;
  }
  return getDefaultMagicPromptTemplate(id);
};

export const renderMagicPrompt = async (id: MagicPromptId, variables: Record<string, string> = {}): Promise<string> => {
  const template = await getEffectiveMagicPromptTemplate(id);
  return replaceTemplateVariables(template, variables);
};

export const saveMagicPromptOverride = async (id: MagicPromptId, text: string): Promise<MagicPromptOverridesPayload> => {
  const response = await runtimeFetch(`${API_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to save magic prompt');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};

export const resetMagicPromptOverride = async (id: MagicPromptId): Promise<MagicPromptOverridesPayload> => {
  const response = await runtimeFetch(`${API_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to reset magic prompt');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};

export const resetAllMagicPromptOverrides = async (): Promise<MagicPromptOverridesPayload> => {
  const response = await runtimeFetch(API_ENDPOINT, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error((errorPayload as { error?: string })?.error || 'Failed to reset all magic prompts');
  }
  const payload = await response.json();
  cachedOverrides = normalizeOverridesPayload(payload);
  return {
    version: typeof payload?.version === 'number' ? payload.version : 1,
    overrides: cachedOverrides,
  };
};
