import React from 'react';
import type { ChannelModel, ModelCatalogField } from '@varin/application-client';

export const ModelFieldContext = React.createContext<{
  model: ChannelModel; defaults?: ChannelModel;
  restored: Partial<Record<ModelCatalogField, number>>;
  onFollow(field: ModelCatalogField): void;
} | null>(null);
