import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
export function SettingsPageLink({ page, children, description, className }: { page: string; children: React.ReactNode; description?: React.ReactNode; className?: string }) {
  return <Button type="button" variant="ghost" className={cn('h-auto min-h-10 w-full justify-between gap-4 px-0 py-3 text-left', className)} onClick={() => requestSettingsNavigation(() => useUIStore.getState().setSettingsPage(page))}>
    <span className="min-w-0"><span className="block typography-ui-label">{children}</span>{description ? <span className="mt-1 block whitespace-normal typography-meta font-normal text-muted-foreground">{description}</span> : null}</span><Icon name="arrow-right-s" className="size-4 shrink-0" />
  </Button>;
}
