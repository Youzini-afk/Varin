import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import type { I18nKey, I18nParams } from '@/lib/i18n/store';
export function nativeObjectLabel(key: Extract<I18nKey, `ui.native.${string}`>, params?: I18nParams): string {
  return formatMessage(useI18nStore.getState().dictionary, key, params);
}
