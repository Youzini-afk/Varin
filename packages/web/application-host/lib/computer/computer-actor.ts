import type { ComputerActor, ComputerWorkScope } from '@varin/protocol';

export interface ComputerWorkResolution {
  scope: ComputerWorkScope;
  actor: ComputerActor | null;
}
