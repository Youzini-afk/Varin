import React from 'react';
import { DEFAULT_CHAT_CONTENT_WIDTH, isChatContentWidth } from '@varin/application-client';

const usePrePaintEffect = React.useInsertionEffect ?? React.useLayoutEffect;

export const useChatContentWidth = (width: number) => {
  usePrePaintEffect(() => {
    if (typeof document === 'undefined') return;
    const value = isChatContentWidth(width) ? width : DEFAULT_CHAT_CONTENT_WIDTH;
    document.documentElement.style.setProperty('--chat-content-width', value === 0 ? '100%' : `${value}px`);
    return () => { document.documentElement.style.removeProperty('--chat-content-width'); };
  }, [width]);
};
