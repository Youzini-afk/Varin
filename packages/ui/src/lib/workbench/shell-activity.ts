import React from 'react';

/** Prepared Shells acquire active UI resources only after authority selects them. */
export const WorkbenchShellActiveContext = React.createContext(true);
export const useWorkbenchShellActive = (): boolean => React.useContext(WorkbenchShellActiveContext);
