import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

// These doubles represent acquired resources, not process behavior. The owner
// under test is the fixture itself; its temp directory and rollback are real.
const resources = vi.hoisted(() => ({
  start: vi.fn(), close: vi.fn(), disposeDocuments: vi.fn(), disposeAdapter: vi.fn(),
  disposeService: vi.fn(), createClient: vi.fn(), bind: vi.fn(),
}));
vi.mock('../kernel/kernel-client.js', () => ({ createKernelClient: resources.createClient }));
vi.mock('../documents/authority.js', () => ({ createDocumentAuthority: () => ({
  dispose: resources.disposeDocuments, bindDurableMutationStorage: resources.bind,
}) }));
vi.mock('../kernel/storage-adapter.js', () => ({ KernelStorageAdapter: class {
  bindFileStore() {}
  dispose = resources.disposeAdapter;
} }));
vi.mock('../kernel/file-resource-backend.js', () => ({ KernelFileResourceBackend: class {} }));
vi.mock('../kernel/kernel-recovery-store.js', () => ({ KernelRecoveryContentStore: class {}, KernelRecoveryStore: class {} }));
vi.mock('../kernel/process-service.js', () => ({ createKernelProcessService: () => ({ dispose: resources.disposeService }) }));

vi.stubEnv('VARIN_TEST_KERNEL_PATH', process.execPath);
const { createNativeProcessTestHarness } = await import('./native-process.test-helper.js');
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.resetAllMocks();
  resources.start.mockResolvedValue(undefined);
  resources.createClient.mockImplementation(() => ({ start: resources.start, close: resources.close }));
});
const createdRoot = () => path.dirname(resources.createClient.mock.calls[0]![0].storageRoot as string);

it('rolls back owned resources when kernel startup fails before get can return', async () => {
  const failed = new Error('handshake rejected');
  resources.start.mockRejectedValue(failed);
  const fixture = createNativeProcessTestHarness();
  await expect(fixture.get()).rejects.toBe(failed);
  expect(resources.close).toHaveBeenCalledOnce();
  expect(resources.disposeDocuments).toHaveBeenCalledOnce();
  expect(fs.existsSync(createdRoot())).toBe(false);
  await fixture.dispose();
  expect(resources.close).toHaveBeenCalledOnce();
});

it('releases later resources and the directory even when one teardown fails', async () => {
  const fixture = createNativeProcessTestHarness();
  await fixture.get();
  const failed = new Error('process teardown failed');
  resources.disposeService.mockRejectedValue(failed);
  await expect(fixture.dispose()).rejects.toMatchObject({ errors: [failed] });
  expect(resources.disposeAdapter).toHaveBeenCalledOnce();
  expect(resources.close).toHaveBeenCalledOnce();
  expect(resources.disposeDocuments).toHaveBeenCalledOnce();
  expect(fs.existsSync(createdRoot())).toBe(false);
  await fixture.dispose();
  expect(resources.disposeService).toHaveBeenCalledOnce();
});

it('does not dispose a caller-owned document authority during rollback', async () => {
  resources.start.mockRejectedValue(new Error('handshake rejected'));
  const dispose = vi.fn();
  const fixture = createNativeProcessTestHarness({ dispose } as never);
  await expect(fixture.get()).rejects.toThrow('handshake rejected');
  expect(dispose).not.toHaveBeenCalled();
  expect(fs.existsSync(createdRoot())).toBe(false);
});
