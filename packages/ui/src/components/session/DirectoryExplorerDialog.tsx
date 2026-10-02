import React from 'react';
import { DirectoryPickerDialog, type DirectoryPickerDialogProps } from './DirectoryPickerDialog';
import { ProjectCreateDialog } from '@/components/sections/projects/ProjectCreateDialog';

export function DirectoryExplorerDialog(props: DirectoryPickerDialogProps) {
  return props.mode === 'select-directory'
    ? <DirectoryPickerDialog {...props} />
    : <ProjectCreateDialog open={props.open} onOpenChange={props.onOpenChange} initialPath={props.initialPath} />;
}
