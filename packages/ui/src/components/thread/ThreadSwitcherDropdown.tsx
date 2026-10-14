import React from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ThreadSidebar } from './ThreadSidebar';
export function ThreadSwitcherDropdown({ align = 'start', children }: { align?: 'start' | 'center' | 'end'; children: React.ReactElement }) {
  return <DropdownMenu><DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger><DropdownMenuContent align={align} className="h-[min(70vh,42rem)] w-[min(22rem,calc(100vw-1rem))]"><ThreadSidebar /></DropdownMenuContent></DropdownMenu>;
}
