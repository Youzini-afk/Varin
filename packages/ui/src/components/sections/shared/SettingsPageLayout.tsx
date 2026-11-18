import React from 'react';
import './settings.css';
import { SettingsFooterContext } from './settings-context';
import { PageHeader } from './kit';
import { cn } from '@/lib/utils';

interface SettingsPageLayoutProps {
  children: React.ReactNode;
  title?: React.ReactNode;
  titleLeading?: React.ReactNode;
  titleAccessory?: React.ReactNode;
  description?: React.ReactNode;
  /** Content at the end of the header row (actions). */
  headerEnd?: React.ReactNode;
  scope?: React.ReactNode;
  /** Instant-save pages flash "Saved" in the header. */
  showSaveStatus?: boolean;
  className?: string;
  outerClassName?: string;
  wide?: boolean;
  /** Content between the header and the first section. */
  lead?: React.ReactNode;
}

/**
 * Preference-form page: header with scope label and save feedback, sections below.
 * Save units dock over the canvas bottom through SettingsFooterContext.
 */
export const SettingsPageLayout: React.FC<SettingsPageLayoutProps> = ({
  children, className, outerClassName, title, titleLeading, titleAccessory, description, headerEnd, scope, showSaveStatus = true, wide, lead,
}) => {
  const [footerTarget, setFooterTarget] = React.useState<HTMLDivElement | null>(null);
  const hasHeader = title != null || description != null || headerEnd != null;
  const isWide = wide || Boolean(className?.match(/settings-(chat|wide)-page/));
  return <SettingsFooterContext.Provider value={footerTarget}>
    <div className={cn('flex h-full min-h-0 flex-col', outerClassName)}>
      <div className="sk-scroll" data-settings-page-scroll="">
        <div data-settings-page="" className={cn('sk-page', isWide && 'wide', className)}>
          {hasHeader ? <PageHeader
            title={titleLeading || titleAccessory ? <>{titleLeading}{title}{titleAccessory}</> : title}
            description={description}
            scope={scope ? <span className="sk-scope"><span>{scope}</span></span> : undefined}
            actions={headerEnd}
            saved={showSaveStatus}
          /> : null}
          {lead ? <div className="sk-lead">{lead}</div> : null}
          {children}
        </div>
      </div>
      <div ref={setFooterTarget} className="sk-footer-slot" />
    </div>
  </SettingsFooterContext.Provider>;
};
