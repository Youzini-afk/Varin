import React from 'react';

export const DisclosureContext = React.createContext<Map<string, boolean> | null>(null);
export const TimelineSessionContext = React.createContext<string | undefined>(undefined);
export const ExpandedToolContext = React.createContext(false);
export const useToolDisclosureChoices = () => React.useContext(DisclosureContext);
