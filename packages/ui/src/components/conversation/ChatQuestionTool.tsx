import React from 'react';
import { readUserQuestions, userAnswerText, type QuestionAnswer } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useOptionalConversationPresentation } from './ConversationContext';
import { ToolDisclosure, ToolStatus } from './ToolDisclosure';
import { useToolOperation } from './useToolOperation';
import { toolRecord, toolText } from './toolInvocation';
import type { ToolViewProps } from './toolViewTypes';

export function ChatQuestionTool({ call, execution, result, status, generating, details }: ToolViewProps) {
  const { t } = useI18n(), conversation = useOptionalConversationPresentation();
  const args = toolRecord(call.arguments), data = toolRecord(result?.details ?? execution?.result);
  const id = call.name === 'question_status' ? toolText(args.operationId) : execution?.operationId || toolText(data.operationId);
  const reader = useToolOperation(id || undefined, call.name === 'ask_user' ? execution?.operation : undefined);
  const operation = reader.operation;
  const control = { ...(operation?.result?.kind === 'control' ? toolRecord(operation.result.value) : data), ...toolRecord(execution?.questionResponse) };
  const questions = readUserQuestions(call.name === 'ask_user' ? args : toolRecord(toolRecord(operation?.intent).call).arguments);
  const answers = Array.isArray(control.answers) ? control.answers as unknown as QuestionAnswer[] : [];
  const answered = typeof control.answer === 'string' || control.status === 'answered';
  const cancelled = operation?.outcome === 'cancelled' || control.cancelled === true || control.status === 'cancelled';
  const waiting = !answered && !cancelled && (operation?.phase === 'waiting' || status === 'waiting' || status === 'background');
  const opened = React.useRef(false);
  return <section className="conversation-question">
    <ToolDisclosure id={'question:' + call.id} className="conversation-question-detail" onExpanded={open => {
      if (open && !opened.current && !operation && reader.available) void reader.refresh();
      opened.current = open;
    }}>
      <summary><Icon name={answered ? 'check' : 'question'} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{questions[0]?.question || t(call.name === 'question_status' || answered || cancelled ? 'chat.tools.question' : 'chat.questionCard.inputNeeded')}</span>
        {questions.length > 1 && <span className="typography-micro text-muted-foreground">{questions.length}</span>}
        {answered || cancelled ? <span className="typography-micro text-muted-foreground">{t(answered ? 'chat.question.answered' : 'chat.timeline.tools.cancelled')}</span>
          : !waiting && <ToolStatus status={status} generating={generating} />}
        <Icon name="arrow-right-s" className="tool-disclosure-chevron size-3.5" />
      </summary>
      <div className="conversation-question-content">
        {questions.map(q => <div key={q.id}><p>{q.question}</p>
          {answered && <p className="text-muted-foreground">{userAnswerText(q, answers.find(answer => answer.questionId === q.id)) || (questions.length === 1 ? toolText(control.answer) : t('chat.question.skipped'))}</p>}
        </div>)}
        {answered && !questions.length && <p>{toolText(control.answer)}</p>}
        {reader.error && <p role="alert" className="text-destructive">{reader.error} <button type="button" className="tool-text-button" onClick={() => void reader.refresh()}>{t('chat.tools.refresh')}</button></p>}
        {details}
      </div>
    </ToolDisclosure>
    {waiting && id && conversation?.revealQuestion && <button type="button" className="tool-text-button ml-6" onClick={() => conversation.revealQuestion?.(id)}>{t('chat.questionCard.inputNeeded')}</button>}
  </section>;
}
