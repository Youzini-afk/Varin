import assert from 'node:assert/strict';

// Stateful external-registry boundary: the release owner chooses every source,
// destination, ordering and retry; the fixture only stores/copies image bytes.
export function imageRegistryFixture(images) {
  const manifests = new Map(), configs = new Map(), events = [], denied = new Set();
  const fail = { target: null, lookup: null, copiedDigest: null };
  const repository = ref => ref.split('@')[0].replace(/:[^/]*$/, '');
  const add = (image, role, variant) => {
    const [repo, imageDigest] = image.split('@');
    const children = ['amd64', 'arm64'].map((architecture, index) => {
      const childDigest = `${imageDigest.slice(0, -1)}${index + 8}`;
      configs.set(`${repo}@${childDigest}`, { os: 'linux', architecture, config: {
        Labels: { 'io.varin.image.role': role, 'io.varin.image.variant': variant,
          'org.opencontainers.image.version': '0.9.38' }, // An intentionally reused base label.
        Env: [`VARIN_IMAGE_VARIANT=${variant}`],
      } });
      return { digest: childDigest, platform: { os: 'linux', architecture } };
    });
    manifests.set(image, { digest: imageDigest, schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: children });
  };
  add(images.standardApp, 'application', 'slim');
  add(images.toolbeltApp, 'application', 'toolbelt');
  add(images.slimBase, 'runtime-base', 'slim');
  add(images.toolbeltBase, 'runtime-base', 'toolbelt');
  const access = (ref, options) => {
    events.push({ type: 'read', ref, ...options });
    if (options?.anonymous && (denied.has(ref) || denied.has(repository(ref)))) throw new Error('401 Unauthorized');
    if (ref === fail.lookup) throw new Error('403 Forbidden');
  };
  const registry = {
    manifest(ref, options) {
      access(ref, options);
      const value = manifests.get(ref);
      if (!value && !options?.allowMissing) throw new Error(`Missing fixture manifest: ${ref}`);
      return value ?? null;
    },
    config(ref, options) { access(ref, options); return configs.get(ref); },
    copy(from, to) {
      events.push({ type: 'copy', from, to });
      const value = manifests.get(from);
      assert.ok(value, `Missing fixture copy source: ${from}`);
      const repo = repository(to), oldRepo = repository(from);
      const copied = fail.copiedDigest ? { ...value, digest: fail.copiedDigest } : value;
      manifests.set(to, copied);
      manifests.set(`${repo}@${value.digest}`, copied);
      for (const child of value.manifests) configs.set(`${repo}@${child.digest}`, configs.get(`${oldRepo}@${child.digest}`));
      if (to === fail.target) { fail.target = null; throw new Error('Connection lost after the registry wrote the tag'); }
    },
  };
  const formalWrites = () => events.filter(event => event.type === 'copy' && !event.to.includes(':candidate-'));
  return { registry, manifests, configs, events, denied, fail, add, formalWrites };
}

