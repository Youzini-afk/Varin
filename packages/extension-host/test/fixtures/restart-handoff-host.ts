import { ApplicationExtensionRuntime } from '../../src/application-runtime.js';
import { createAuthoredPanelConsumer } from '../../../ui/src/lib/extensions/authored-surface-consumer.test-support.js';
import type { SurfaceExtensionHost } from '@varin/extension-loader';

const runtime = await ApplicationExtensionRuntime.create({ dataDir: process.argv[2]!, varinVersion: '1.2.3',
  brokerScript: new URL('../../broker/broker-child.mjs', import.meta.url).pathname });
let consumer: Awaited<ReturnType<typeof createAuthoredPanelConsumer>> | undefined;
let releaseMount: (() => void) | undefined;
const globals = globalThis as typeof globalThis & { handoffMountGate?: Promise<void>; handoffMounts?: string[]; failHandoffMount?: boolean };
const state = () => runtime.state();
const snapshot = () => runtime.catalog.snapshot();
const host: SurfaceExtensionHost = {
  activateExtension: id => runtime.activateExtension(id),
  catalog: async () => ({ supported: true, status: 'ready', snapshot: await snapshot() }),
  discardPreparedCandidate: (id, integrity) => runtime.discardPreparedCandidate(id, integrity),
  hostState: state,
  invokeService: (request, signal) => runtime.invokeService(request, signal),
  watchServiceLease: (request, emit, signal) => runtime.watchServiceLease(request, 'restart-test-user', emit, signal),
  prepareCandidate: (id, integrity, signal) => runtime.prepareCandidate(id, integrity, signal),
  requestCandidateApplication: request => runtime.requestCandidateApplication(request),
  readAsset: request => runtime.packages.readAsset(request),
  readManagedEntrypoint: request => runtime.packages.readManagedEntrypoint(request),
  reportActualState: (id, actual) => runtime.reportActualState(id, actual),
  selectCandidate: (request, signal) => runtime.selectCandidate(request, signal),
  waitForHostState: (request, signal) => runtime.waitForState(request, signal),
};
process.on('message', async (message: { id: number; operation: string; args?: Record<string, unknown> }) => {
  try {
    const args = message.args ?? {};
    let result: unknown;
    switch (message.operation) {
      case 'state': result = await state(); break;
      case 'install': result = await runtime.installOrStage({ source: { kind: 'local', display: 'Restart test', specifier: args.directory }, expectedRevision: (await snapshot()).revision }); break;
      case 'request': {
        const catalog = await snapshot(), entry = catalog.extensions.find(value => value.manifest.id === args.extensionId)!;
        result = await runtime.requestRestartHandoff({ extensionId: args.extensionId, handoffId: args.handoffId,
          candidateIntegrity: entry.candidate!.integrity, expectedRevision: catalog.revision }); break;
      }
      case 'apply': {
        const catalog = await snapshot(), entry = catalog.extensions.find(value => value.manifest.id === args.extensionId)!;
        const requested = await runtime.requestCandidateApplication({ extensionId: args.extensionId, candidateIntegrity: entry.candidate!.integrity, expectedRevision: catalog.revision });
        result = await runtime.prepareCandidate(String(args.extensionId), requested.extensions.find(value => value.manifest.id === args.extensionId)!.candidate!.integrity); break;
      }
      case 'recover': result = await runtime.recoverRestartHandoff({ extensionId: args.extensionId, handoffId: args.handoffId, expectedRevision: (await snapshot()).revision }); break;
      case 'disable': result = await runtime.setEnabled(String(args.extensionId), false, (await snapshot()).revision); break;
      case 'service': result = await runtime.invokeService({ serviceId: args.serviceId, version: 1, method: 'read', args: [] }); break;
      case 'surface': {
        globals.failHandoffMount = args.failMount === true;
        if (args.blockMount) globals.handoffMountGate = new Promise(resolve => { releaseMount = resolve; });
        if (args.lostResponse) host.selectCandidate = async (request, signal) => {
          await runtime.selectCandidate(request, signal);
          throw new Error('Simulated loss after the original Catalog commit');
        };
        consumer = await createAuthoredPanelConsumer(host);
        await consumer.reconcile();
        result = { state: await state(), errors: consumer.errors.map(String), mounts: globals.handoffMounts ?? [] };
        break;
      }
      case 'mounts': result = globals.handoffMounts ?? []; break;
      case 'releaseMount': releaseMount?.(); result = null; break;
      case 'stop': await consumer?.close(); await runtime.stop(); result = null; break;
      default: throw new Error(`Unknown test operation: ${message.operation}`);
    }
    process.send?.({ id: message.id, result });
    if (message.operation === 'stop') process.disconnect();
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});
await runtime.start();
process.send?.({ ready: true, state: await state() });
