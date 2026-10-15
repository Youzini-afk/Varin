type DesktopWorkspaceView = 'loading' | 'main' | 'catalog-recovery';
export const resolveDesktopWorkspaceView = (input: { catalogError: unknown; catalogLoaded: boolean; catalogLoading?: boolean }): DesktopWorkspaceView => {
  if (input.catalogLoaded) return 'main';
  if (input.catalogLoading) return 'loading';
  return input.catalogError ? 'catalog-recovery' : 'loading';
};
export const desktopWorkspaceIsOperable = (view: DesktopWorkspaceView, isSwitchingDirectory: boolean): boolean => view === 'main' && !isSwitchingDirectory;
