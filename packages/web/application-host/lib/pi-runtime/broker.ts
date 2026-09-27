import { applicationHostClientCapabilities, PiRuntimeBroker, resolveBundledPiHostEntry } from '@varin/runtime-broker';
import type {
  PiRuntimeBrokerOptions,
  PiSessionExecutionAdmission,
} from '@varin/runtime-broker';
import { FOUNDATIONAL_PI_PACKAGE_MANIFEST } from '@varin/protocol';

export function attachPiSessionExecutionAdmission<Broker extends Pick<PiRuntimeBroker, 'setSessionExecutionAdmission'>>(
  broker: Broker,
  admitSessionExecution: PiSessionExecutionAdmission,
): Broker;
export function attachPiSessionExecutionAdmission(
  broker: unknown,
  admitSessionExecution: PiSessionExecutionAdmission,
): Pick<PiRuntimeBroker, 'setSessionExecutionAdmission'>;
export function attachPiSessionExecutionAdmission(
  broker: unknown,
  admitSessionExecution: PiSessionExecutionAdmission,
): Pick<PiRuntimeBroker, 'setSessionExecutionAdmission'> {
  const candidate = broker && typeof broker === 'object'
    ? broker as { setSessionExecutionAdmission?: unknown }
    : null;
  if (!candidate || typeof candidate.setSessionExecutionAdmission !== 'function') {
    throw new TypeError('Injected Pi runtime broker does not support session execution admission');
  }
  const compatible = broker as Pick<PiRuntimeBroker, 'setSessionExecutionAdmission'>;
  compatible.setSessionExecutionAdmission(admitSessionExecution);
  return compatible;
}

export function createWebPiRuntimeBroker({
  agentDir,
  admitSessionExecution,
  clientVersion,
  cwd,
  emit = () => {},
  foundationalPackages = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations,
  hostEntry,
  harnessDocumentRead = false,
  harnessDocumentPathOverlay = false,
  harnessWebRead = false,
  harnessWebSearch = false,
  nodePath,
  packageRoot,
  runtimeGeneration,
  runtimeSource,
  resolveProjectWorkFocus,
}: {
  agentDir?: string | undefined;
  admitSessionExecution?: PiSessionExecutionAdmission | undefined;
  clientVersion?: string | undefined;
  cwd?: string | undefined;
  emit?: PiRuntimeBrokerOptions['emit'] | undefined;
  foundationalPackages?: PiRuntimeBrokerOptions['foundationalPackages'] | undefined;
  hostEntry?: string | undefined;
  harnessDocumentRead?: boolean | undefined;
  harnessDocumentPathOverlay?: boolean | undefined;
  harnessWebRead?: boolean | undefined;
  harnessWebSearch?: boolean | undefined;
  nodePath?: string | undefined;
  packageRoot?: string | undefined;
  runtimeGeneration?: number | undefined;
  runtimeSource?: PiRuntimeBrokerOptions['runtimeSource'] | undefined;
  resolveProjectWorkFocus?: PiRuntimeBrokerOptions['resolveProjectWorkFocus'] | undefined;
} = {}): PiRuntimeBroker {
  return new PiRuntimeBroker({
    ...(typeof agentDir === 'string' && agentDir.trim() ? { agentDir: agentDir.trim() } : {}),
    ...(typeof admitSessionExecution === 'function' ? { admitSessionExecution } : {}),
    client: {
      capabilities: applicationHostClientCapabilities({
        documentRead: harnessDocumentRead,
        documentPathOverlay: harnessDocumentPathOverlay,
        webRead: harnessWebRead,
        webSearch: harnessWebSearch,
      }),
      clientName: 'varin-web-server',
      clientVersion: typeof clientVersion === 'string' && clientVersion ? clientVersion : '0.1.0',
      mode: 'headless',
    },
    ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
    emit,
    foundationalPackages,
    hostEntry: hostEntry || resolveBundledPiHostEntry(),
    ...(nodePath ? { nodePath } : {}),
    ...(packageRoot ? { packageRoot } : {}),
    ...(typeof runtimeGeneration === 'number' && Number.isSafeInteger(runtimeGeneration) && runtimeGeneration > 0
      ? { runtimeGeneration }
      : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
    ...(resolveProjectWorkFocus ? { resolveProjectWorkFocus } : {}),
  });
}
