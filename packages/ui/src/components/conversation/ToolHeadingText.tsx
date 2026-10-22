import React from 'react';

/** Shared typography only. Each tool owns the meaning of its action, subject and receipt. */
export function ToolHeadingText({ label, subject, receipt }: { label: string; subject?: string; receipt?: string }) {
  return <span className="tool-heading-copy typography-meta">
    <span className="tool-heading-label" title={label}>{label}</span>{' '}
    {subject && <span className="tool-heading-subject" title={subject}>{subject.replace(/\s+/g, ' ').trim()}</span>}{' '}
    {receipt && <span className="tool-heading-receipt typography-micro" title={receipt}>{receipt}</span>}
  </span>;
}
