import { createHash } from 'node:crypto';
import {
  canonicalServiceComposition,
  parseVarinHostServiceComposition,
  type VarinHostCompositionNode,
  type VarinHostServiceComposition,
} from '@varin/extension-contract';

/** A standalone fixture provider declares no Host grants or service dependencies. */
export function leafHostComposition(
  identity: Pick<VarinHostCompositionNode, 'extensionId' | 'extensionVersion' | 'artifactIntegrity'>,
): VarinHostServiceComposition {
  const body: Omit<VarinHostCompositionNode, 'id'> = {
    ...identity,
    entrypointId: 'host',
    activationConfiguration: null,
    grants: [],
    dependencies: [],
  };
  const id = createHash('sha256').update(canonicalServiceComposition(body)).digest('hex');
  return parseVarinHostServiceComposition({ schemaVersion: 1, root: id, nodes: [{ ...body, id }] });
}
