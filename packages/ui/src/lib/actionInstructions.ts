// Text for concrete product actions. These are ordinary request builders, with no user template store.
const requests = {
  'plan.improve.visible': (values: Record<string, string>) => `Improve this plan: ${values.plan_title ?? ''}`,
  'plan.improve.instructions': (values: Record<string, string>) => `Improve the plan in ${values.plan_path ?? ''} (${values.plan_title ?? ''}) using the current project context.`,
  'plan.implement.visible': (values: Record<string, string>) => `Implement this plan: ${values.plan_title ?? ''}`,
  'plan.implement.instructions': (values: Record<string, string>) => `Implement the plan in ${values.plan_path ?? ''} (${values.plan_title ?? ''}), taking the current project state into account.`,
  "git.commit.generate.visible": () => `Draft a Conventional Commit message from the diffs of the selected files.`,
  "git.commit.generate.instructions": (values: Record<string, string>) => `Return JSON with "subject" (string) and "highlights" (up to three strings).

Selected files:
${values.selected_files ?? ''}`,
  "git.pr.generate.visible": () => `Draft a pull request title and description for these changes.`,
  "git.pr.generate.instructions": (values: Record<string, string>) => `Return JSON with "title" and "body" string fields. The body is Markdown.

Base branch: ${values.base_branch ?? ''}
Head branch: ${values.head_branch ?? ''}

Commits in range (base...head):
${values.commits ?? ''}

Files changed across these commits:
${values.changed_files ?? ''}${values.additional_context_block ?? ''}`,
  "github.pr.review.visible": (values: Record<string, string>) => `Review this pull request #${values.pr_number ?? ''} using the provided PR context`,
  "github.pr.review.instructions": () => `Assess whether the pull request achieves its intent and identify issues introduced by its changes. The working tree may differ from the PR; use the supplied diff to identify the changes and relevant repository code to explain your findings.`,
  "github.issue.review.visible": (values: Record<string, string>) => `Review this issue #${values.issue_number ?? ''} using the provided issue context`,
  "github.issue.review.instructions": () => `Assess the issue using the supplied description, discussion, and relevant project context. Explain possible ways to address it.`,
  "git.conflict.resolve.visible": (values: Record<string, string>) => `Resolve the ${values.operation_label ?? ''} conflicts, preserving the intent of the changes from ${values.head_ref ?? ''}.`,
  "git.conflict.resolve.instructions": (values: Record<string, string>) => `Git ${values.operation_label ?? ''} is in progress with conflicts.

Directory: ${values.directory ?? ''}
Operation: ${values.operation ?? ''}
Head: ${values.head_info ?? ''}
Command to continue after resolving and staging: ${values.continue_cmd ?? ''}`,
  "git.integrate.cherrypick.resolve.visible": (values: Record<string, string>) => `Resolve cherry-pick conflicts, stage the resolved files, and continue the cherry-pick. Keep intent of commit ${values.current_commit ?? ''} onto branch ${values.target_branch ?? ''}.`,
  "git.integrate.cherrypick.resolve.instructions": (values: Record<string, string>) => `The cherry-pick is in progress with conflicts in this worktree: ${values.temp_worktree_path ?? ''}

Repository: ${values.repo_root ?? ''}
Source branch: ${values.source_branch ?? ''}
Target branch: ${values.target_branch ?? ''}
Current commit: ${values.current_commit ?? ''}
Command to continue after resolving and staging: git cherry-pick --continue`,
  "plan.todo.visible": (values: Record<string, string>) => `${values.todo_text ?? ''}`,
  "plan.todo.instructions": (values: Record<string, string>) => `Prepare an implementation plan for this project todo using the current project context:

${values.todo_text ?? ''}`,
  "session.reviewHandoff.visible": () => `Prepare a handoff for another agent to review this work.`,
  "session.reviewHandoff.instructions": () => `Varin will send this response to another agent reviewing the work. Summarize the user's intent, the changes, relevant decisions, validation, and anything still unresolved.`,
  "session.reviewSession.visible": (values: Record<string, string>) => `Review the changes described below against the current code and the stated intent.

${values.handoff ?? ''}`,
  "session.reviewSessionWithoutHandoff.visible": () => `Review the current workspace changes using the diff and relevant project context.`,
  "session.reviewFeedbackToImplementer.visible": (values: Record<string, string>) => `Another agent reviewed the changes. Assess the feedback below and address the relevant findings.

${values.review_feedback ?? ''}`,
  "session.implementationResponseToReviewer.visible": (values: Record<string, string>) => `Recheck the work in light of the implementation response below and report any remaining issues.

${values.implementation_response ?? ''}`,
};
export function actionInstruction(id: keyof typeof requests, values: Record<string, string> = {}): string {
  return requests[id](values);
}
