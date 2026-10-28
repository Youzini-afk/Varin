import { createConfiguredWebAPIs } from './runtimeConfig';
import { renderCompanionApp } from '@varin/ui/apps/renderCompanionApp';

renderCompanionApp(createConfiguredWebAPIs());
