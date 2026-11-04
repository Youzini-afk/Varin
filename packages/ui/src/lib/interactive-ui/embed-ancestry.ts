import React from 'react';
/** A render path, not a permission grant or persisted source of truth. */
export const UiEmbedAncestryContext = React.createContext<readonly string[]>([]);
