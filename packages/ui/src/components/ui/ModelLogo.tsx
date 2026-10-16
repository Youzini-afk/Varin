import React from 'react';
import { ProviderLogo } from './ProviderLogo';
import { modelBrandLogo, resolveModelBrand, type ModelBrandIdentity } from '@/lib/modelBrand';
import { cn } from '@/lib/utils';

/** A fixed 20px model-family mark. The provider/channel never supplies its identity. */
export function ModelLogo({ requestModelId, modelId, displayName, className }: ModelBrandIdentity & { className?: string }) {
  const brand = resolveModelBrand({ requestModelId, modelId, displayName });
  return <span aria-hidden="true" data-model-brand={brand} className={cn('inline-flex size-5 shrink-0 items-center justify-center text-foreground', className)}>
    {brand === 'unknown' ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.25l8 4.5v4.5" /></svg>
      : <ProviderLogo providerId={modelBrandLogo[brand]} alt="" className="size-5" />}
  </span>;
}
