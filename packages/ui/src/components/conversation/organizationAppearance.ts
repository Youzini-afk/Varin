import type { IconName } from '@/components/icon/icons';
import { iconSpriteData } from '@/components/icon/sprite';

export const ORGANIZATION_ICONS = ['stack', 'briefcase', 'rocket', 'palette', 'book-open', 'lightbulb', 'code-box', 'folder', 'global'] as const satisfies readonly IconName[];
export const ORGANIZATION_COLORS = ['', 'var(--syntax-keyword)', 'var(--syntax-string)', 'var(--syntax-type)', 'var(--syntax-constant)'];
export const organizationIcon = (icon: string | null): IconName => icon && Object.hasOwn(iconSpriteData, icon) ? icon as IconName : 'stack';
