import { resetAgentFileChangeHints } from './hints';
import { resetEditorSessionLinks } from './navigation';

export const resetAgentEditorCoordination = (): void => {
  resetAgentFileChangeHints();
  resetEditorSessionLinks();
};
