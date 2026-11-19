import React from 'react';
import { DrawerContext, type DrawerContextValue } from './drawer-context-value';

export const DrawerProvider: React.FC<{
    children: React.ReactNode;
    value: DrawerContextValue;
}> = ({ children, value }) => {
    return (
        <DrawerContext.Provider value={value}>
            {children}
        </DrawerContext.Provider>
    );
};
