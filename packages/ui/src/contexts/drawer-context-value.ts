import { createContext, useContext, type MutableRefObject } from 'react';
import type { MotionValue } from 'motion/react';

export interface DrawerContextValue {
    leftDrawerOpen: boolean;
    rightDrawerOpen: boolean;
    toggleLeftDrawer: () => void;
    toggleRightDrawer: () => void;
    leftDrawerX: MotionValue<number>;
    rightDrawerX: MotionValue<number>;
    leftDrawerWidth: MutableRefObject<number>;
    rightDrawerWidth: MutableRefObject<number>;
    setMobileLeftDrawerOpen: (open: boolean) => void;
    setRightSidebarOpen: (open: boolean) => void;
}

export const DrawerContext = createContext<DrawerContextValue | null>(null);
export const useOptionalDrawer = () => useContext(DrawerContext);
