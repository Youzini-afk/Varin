import React from 'react';
import type { ResourceFileLocation } from '@varin/application-client';
/** File previews resolve their embedded assets in the same admitted source. */
export const MarkdownResourceContext = React.createContext<{ location: ResourceFileLocation; resourceId: string } | null>(null);
