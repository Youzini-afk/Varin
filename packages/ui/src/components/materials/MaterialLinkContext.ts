import { createContext } from 'react';

/** A conversation-local owner consumes citations before any legacy global handler. */
export const MaterialLinkContext = createContext<((href: string, title: string) => void) | null>(null);
