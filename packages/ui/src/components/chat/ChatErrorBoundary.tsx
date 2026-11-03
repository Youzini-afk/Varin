import React from 'react';
import { RiChat3Line, RiRestartLine } from '@remixicon/react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';

interface ChatErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
  resetKey?: string;
  copied?: boolean;
}

interface ChatErrorBoundaryProps {
  children: React.ReactNode;
  sessionId?: string;
  /** Host and complete conversation identity. Changing it releases only this view error. */
  resetKey?: string;
}

interface ChatErrorBoundaryTexts {
  title: string;
  description: string;
  sessionLabel: string;
  detailsSummary: string;
  resetAction: string;
  persistentHint: string;
  componentStackLabel: string;
  copy: string;
  copied: string;
}

interface ChatErrorBoundaryViewProps extends ChatErrorBoundaryProps {
  texts: ChatErrorBoundaryTexts;
}

class ChatErrorBoundaryView extends React.Component<ChatErrorBoundaryViewProps, ChatErrorBoundaryState> {
  constructor(props: ChatErrorBoundaryViewProps) {
    super(props);
    this.state = { hasError: false, resetKey: props.resetKey ?? props.sessionId };
  }

  static getDerivedStateFromProps(props: ChatErrorBoundaryViewProps, state: ChatErrorBoundaryState): Partial<ChatErrorBoundaryState> | null {
    const resetKey = props.resetKey ?? props.sessionId;
    return resetKey !== state.resetKey
      ? { resetKey, hasError: false, error: undefined, errorInfo: undefined, copied: false }
      : null;
  }

  static getDerivedStateFromError(error: Error): ChatErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo, copied: false });

    if (process.env.NODE_ENV === 'development') {
      console.error('Chat error caught by boundary:', error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined, copied: false });
  };

  errorDetails = () => {
    const error = this.state.error;
    const stack = this.state.errorInfo?.componentStack;
    return `${error?.stack || String(error)}${stack ? `\n\n${this.props.texts.componentStackLabel}${stack}` : ''}`;
  };

  handleCopy = async () => {
    const original = this.state.error;
    const result = await copyTextToClipboard(this.errorDetails());
    if (result.ok && this.state.hasError && this.state.error === original) this.setState({ copied: true });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen p-4">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <CardTitle className="flex items-center justify-center gap-2 text-destructive">
                <RiChat3Line className="h-5 w-5" />
                {this.props.texts.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                {this.props.texts.description}
              </p>

              {this.props.sessionId && (
                <div className="text-xs text-muted-foreground text-center break-all">
                  {this.props.texts.sessionLabel}: {this.props.sessionId}
                </div>
              )}

              {this.state.error && (
                <details className="text-xs font-mono bg-muted p-3 rounded">
                  <summary className="cursor-pointer hover:bg-interactive-hover/80">{this.props.texts.detailsSummary}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                    {this.errorDetails()}
                  </pre>
                </details>
              )}

              <div className="flex gap-2">
                <Button onClick={this.handleReset} variant="outline" className="flex-1">
                  <RiRestartLine className="h-4 w-4 mr-2" />
                  {this.props.texts.resetAction}
                </Button>
                <Button onClick={() => void this.handleCopy()} variant="outline" className="flex-1">
                  {this.state.copied ? this.props.texts.copied : this.props.texts.copy}
                </Button>
              </div>

              <div className="text-xs text-muted-foreground text-center">
                {this.props.texts.persistentHint}
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

export function ChatErrorBoundary(props: ChatErrorBoundaryProps) {
  const { t } = useI18n();
  return (
    <ChatErrorBoundaryView
      {...props}
      texts={{
        title: t('chat.errorBoundary.title'),
        description: t('chat.errorBoundary.description'),
        sessionLabel: t('chat.errorBoundary.sessionLabel'),
        detailsSummary: t('chat.errorBoundary.detailsSummary'),
        resetAction: t('chat.errorBoundary.resetAction'),
        persistentHint: t('chat.errorBoundary.persistentHint'),
        componentStackLabel: t('errorBoundary.state.componentStackLabel'),
        copy: t('errorBoundary.actions.copy'),
        copied: t('errorBoundary.actions.copied'),
      }}
    />
  );
}
