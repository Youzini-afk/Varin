import React from 'react';

export const DisclosureContext = React.createContext<Map<string, boolean> | null>(null);
export const TimelineSessionContext = React.createContext<string | undefined>(undefined);
export const ExpandedToolContext = React.createContext(false);
/** The image receipt owns these thumbnails; its original tool details must not repeat them. */
export const ViewedImageDetailsContext = React.createContext<string | null>(null);
export const useToolDisclosureChoices = () => React.useContext(DisclosureContext);
