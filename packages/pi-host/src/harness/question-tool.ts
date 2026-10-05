import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { UserQuestion } from "@varin/protocol";
import type { ExtensionUiBridge } from "../extension-ui-bridge.js";

const Option = Type.Union([Type.String(), Type.Object({ label: Type.String(), value: Type.Optional(Type.String()), description: Type.Optional(Type.String()) })]);
const fields = {
  type: Type.Optional(Type.Union([Type.Literal("select"), Type.Literal("confirm"), Type.Literal("input"), Type.Literal("editor")])),
  question: Type.String(),
  options: Type.Optional(Type.Array(Option)),
  allowOther: Type.Optional(Type.Boolean()),
  placeholder: Type.Optional(Type.String()),
  prefill: Type.Optional(Type.String()),
};
const Parameters = Type.Object({
  questions: Type.Optional(Type.Array(Type.Object({ ...fields, id: Type.Optional(Type.String()) }))),
  ...fields, question: Type.Optional(Type.String()),
  wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 600, description: "Omit or use 0 to submit and continue other work. A positive value waits for this many seconds, at most 600; unanswered questions remain available afterward." })),
});

export function createQuestionTool(ui: ExtensionUiBridge, sessionId: string, enabled = true) {
  return defineTool({
    name: "ask_question", label: "Ask question", parameters: Parameters, executionMode: "parallel",
    ...(enabled ? {} : { exposure: "hidden" as const }),
    description: "Ask one or more questions through the user interface. Submit and continue by default, or set wait_seconds for a bounded wait. The user can answer later; unanswered choices are not approvals.",
    promptSnippet: "ask_question: ask the user, either waiting briefly or continuing independent work",
    promptGuidelines: [
      "Use ask_question for user input. Omit wait_seconds to continue independent work; set a positive wait_seconds only when the answer is needed now (maximum 600 seconds). Questions stay available after the popup closes or the wait ends, and later answers arrive as addressed input.",
      "Use select with options for choices, confirm for a yes/no decision, input for short text and editor for multi-line text. Batch related questions in questions[]. No answer is not approval; continue only work that does not depend on the missing decision.",
    ],
    execute: async (toolCallId, params, signal, _update, ctx) => {
      try {
        if (!enabled) throw new Error("ask_question is disabled");
        const raw = params.questions?.length ? params.questions : [{ ...params, id: "default" }];
        const questions: UserQuestion[] = raw.map((question, index) => {
          if (!question.question?.trim()) throw new Error("Question text must be nonempty");
          return { id: question.id ?? "q" + (index + 1), type: question.type ?? "input", question: question.question,
            ...(question.options ? { options: question.options.map(option => typeof option === "string" ? { label: option, value: option } : { ...option, value: option.value ?? option.label }) } : {}),
            ...(question.allowOther === undefined ? {} : { allowOther: question.allowOther }),
            ...(question.placeholder === undefined ? {} : { placeholder: question.placeholder }),
            ...(question.prefill === undefined ? {} : { prefill: question.prefill }) };
        });
        if (new Set(questions.map(question => question.id)).size !== questions.length) throw new Error("Question ids must be unique in a batch");
        const id = sessionId + ":question:" + (ctx.sessionManager.getLeafId() ?? "root") + ":" + toolCallId;
        const submitted = ui.postQuestion(id, questions, params.wait_seconds ?? 0, signal);
        const result = await submitted.result;
        const text = result.status === "answered" ? "User answers:\n" + questions.map(question => question.question + "\n" + String(result.answers?.find(answer => answer.id === question.id)?.value)).join("\n\n")
          : result.status === "cancelled" ? "The user closed this question without answering."
          : "Question " + id + " is awaiting an answer. Continue independent work; do not assume a choice or approval. Later answers will arrive as addressed input.";
        return { content: [{ type: "text", text }], details: { requestId: id, status: result.status, questions, ...(result.answers ? { answers: result.answers } : {}) } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: {} };
      }
    },
  });
}
