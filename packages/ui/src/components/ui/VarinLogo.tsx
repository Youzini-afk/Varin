import React from 'react';
import { motion } from 'motion/react';
import { useI18n } from '@/lib/i18n';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { VARIN_MARK_PATHS, VARIN_MARK_SECONDARY_OPACITY, VARIN_MARK_VIEWBOX } from './varin-mark';

interface VarinLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
  /** Use when a surrounding label already names the mark. */
  decorative?: boolean;
}

export const VarinLogo: React.FC<VarinLogoProps> = ({
  className = '', width = 70, height = 70, isAnimated = false, decorative = false,
}) => {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const working = isAnimated && !reducedMotion;
  const compact = Math.min(width, height) <= 24;

  return (
    <svg width={width} height={height} viewBox={VARIN_MARK_VIEWBOX} fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" className={className}
      {...(decorative ? { 'aria-hidden': true, focusable: false }
        : { role: 'img', 'aria-label': t('varinLogo.aria.logo') })}>
      {VARIN_MARK_PATHS.map((path, index) => {
        const opacity = index === 0 || compact ? 1 : VARIN_MARK_SECONDARY_OPACITY;
        const travel = index === 0 ? -5 : 5;
        return <motion.path key={path} d={path} initial={false}
          animate={working ? { x: [0, travel, 0], y: [0, travel, 0], opacity: [opacity, 1, opacity] }
            : { x: 0, y: 0, opacity }}
          transition={reducedMotion ? { duration: 0 } : working
            ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
            : { type: 'spring', stiffness: 300, damping: 22 }}
        />;
      })}
    </svg>
  );
};
