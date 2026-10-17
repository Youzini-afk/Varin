import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
  VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID,
} from "@varin/extension-builtins";
import {
  resolveVarinBuiltinPackageRoot,
} from "@varin/extension-builtins/host";
import { ApplicationExtensionRuntime } from "../src/application-runtime.js";
import { HostCapabilityRegistry } from '../src/capability-registry.js';

test('teardown admits only Host-declared cleanup methods of the original granted capability', async () => {
  const registry = new HostCapabilityRegistry();
  const owner = { extensionId: 'example.language', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'original', generation: 1 };
  const grants = [{ capability: 'workspace.language', realm: 'host' as const, manifestVersion: '1.0.0', granted: false, updatedAt: new Date().toISOString() }];
  const signal = new AbortController().signal;
  const calls: string[] = [];
  registry.register('workspace.language', (method, _params, context) => {
    assert.equal(context.owner, owner); calls.push(method); return null;
  }, { cleanupMethods: ['unregisterProvider'] });
  const invoke = (method: string, disposing: boolean, original = grants) => registry.invoke(owner, original, 'workspace.language', method, {}, signal, undefined, disposing);
  assert.throws(() => invoke('registerProvider', true), /not granted/);
  assert.throws(() => invoke('unregisterProvider', false), /not granted/);
  assert.throws(() => invoke('unregisterProvider', true, []), /not granted/);
  await invoke('unregisterProvider', true);
  assert.deepEqual(calls, ['unregisterProvider']);
});

test("built-in package roots use Electron's physical ASAR-unpacked directory on every desktop path style", () => {
  const windowsVirtual = "D:\\Varin\\resources\\app.asar\\node_modules\\@varin\\extension-builtins\\dist\\builtin-packages\\typescript-language";
  const windowsPhysical = "D:\\Varin\\resources\\app.asar.unpacked\\node_modules\\@varin\\extension-builtins\\dist\\builtin-packages\\typescript-language";
  const posixVirtual = "/opt/Varin/resources/app.asar/node_modules/@varin/extension-builtins/dist/builtin-packages/typescript-language";
  const posixPhysical = "/opt/Varin/resources/app.asar.unpacked/node_modules/@varin/extension-builtins/dist/builtin-packages/typescript-language";
  const existing = new Set([windowsPhysical, posixPhysical]);

  assert.equal(resolveVarinBuiltinPackageRoot(windowsVirtual, (path) => existing.has(path)), windowsPhysical);
  assert.equal(resolveVarinBuiltinPackageRoot(posixVirtual, (path) => existing.has(path)), posixPhysical);
  assert.equal(resolveVarinBuiltinPackageRoot(windowsPhysical, () => true), windowsPhysical);
  assert.equal(resolveVarinBuiltinPackageRoot("/opt/varin/builtins/typescript-language", () => true), "/opt/varin/builtins/typescript-language");
  assert.equal(resolveVarinBuiltinPackageRoot(posixVirtual, () => false), posixVirtual);
});

test("the built-in TypeScript language extension materializes lazily and unregisters when disabled", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-builtin-language-"));
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    varinVersion: "1.2.3",
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  runtime.capabilities.register("workspace.language", async (method, params) => {
    calls.push({ method, params });
    return { status: method === "registerProvider" ? "registered" : "unregistered" };
  }, { cleanupMethods: ['unregisterProvider'] });
  try {
    const started = await runtime.start();
    const entry = started.catalog.extensions.find((candidate) => (
      candidate.manifest.id === VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID
    ));
    assert.equal(entry?.desired.enabled, true);
    assert.equal(entry?.integrity, undefined);
    assert.equal(calls.length, 0);

    await runtime.activateForEvent("workspace-match", { languageId: "typescript" });
    const registration = calls.find((call) => (
      call.method === "registerProvider"
      && (call.params as { providerId?: unknown } | undefined)?.providerId === "varin.typescript-language"
    ))?.params as {
      args?: string[];
      command?: string;
      initializationOptions?: { tsserver?: { fallbackPath?: string } };
      languageIds?: string[];
      providerId?: string;
    } | undefined;
    assert.equal(registration?.providerId, "varin.typescript-language");
    assert.deepEqual(registration?.languageIds, ["javascript", "javascriptreact", "typescript", "typescriptreact"]);
    assert.match(registration?.args?.[0] ?? "", /typescript-language-server\.mjs$/);
    assert.match(registration?.initializationOptions?.tsserver?.fallbackPath ?? "", /typescript[\\/]lib[\\/]tsserver\.js$/);
    assert.ok(registration?.command);
    const active = await runtime.state();
    const activeEntry = active.catalog.extensions.find((candidate) => (
      candidate.manifest.id === VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID
    ));
    assert.match(activeEntry?.integrity ?? "", /^sha256-[0-9a-f]{64}$/);
    assert.equal(active.catalog.extensions.find((candidate) => (
      candidate.manifest.id === VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID
    ))?.integrity, undefined, "TypeScript activation does not materialize the unrelated language pack");

    await runtime.setEnabled(
      VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
      false,
      active.catalog.revision,
    );
    assert.equal(calls.at(-1)?.method, "unregisterProvider");
  } finally {
    await runtime.stop().catch(() => undefined);
    await rm(dataDir, { force: true, recursive: true });
  }
});
