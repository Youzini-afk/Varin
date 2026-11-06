import assert from "node:assert/strict";
import test from "node:test";
import { extensionSourceIdentity, parseVarinExtensionDiscoveryDocument } from "../src/index.js";

test("optional discovery catalogs preserve arbitrary accepted install sources without becoming an allowlist", () => {
  const document = parseVarinExtensionDiscoveryDocument({
    schemaVersion: 1,
    entries: [{
      id: "dev.example.extension",
      displayName: "Example",
      keywords: ["workflow"],
      source: { display: "Example npm package", kind: "npm", specifier: "@example/varin-extension" },
    }],
  });
  assert.equal(document.entries[0]?.source.specifier, "@example/varin-extension");
  assert.throws(() => parseVarinExtensionDiscoveryDocument({
    schemaVersion: 1,
    entries: [...document.entries, document.entries[0]],
  }), /unique/);
});


test('catalog admission validates release selectors before publication, preserving valid spaced npm ranges', () => {
  const document = (kind: string, specifier: string) => ({ schemaVersion: 1,
    entries: [{ id: 'dev.example.extension', source: { kind, specifier, display: 'Example' } }] });
  for (const specifier of ['not-a-repository', 'owner/repo#nightly', 'owner/repo#stable?manifest=../bad.json', 'owner/repo#stable?token=secret']) {
    assert.throws(() => parseVarinExtensionDiscoveryDocument(document('github-release', specifier)));
  }
  for (const specifier of ['https://registry.npmjs.org/pkg', 'package@>=oops', 'package@', '../package']) {
    assert.throws(() => parseVarinExtensionDiscoveryDocument(document('npm', specifier)));
  }
  const accepted = parseVarinExtensionDiscoveryDocument(document('npm', '@example/plugin@>=1.0.0 <2.0.0 || ^3.0.0'));
  assert.equal(accepted.entries[0]?.source.specifier, '@example/plugin@>=1.0.0 <2.0.0 || ^3.0.0');
});


test('npm source identity normalizes default channel and selector boundary whitespace', () => {
  const identity = (specifier: string) => extensionSourceIdentity({ kind: 'npm', display: 'Example', specifier });
  assert.equal(identity('@example/plugin'), identity(' @example/plugin@latest '));
  assert.equal(identity('@example/plugin@>=1.0.0 <2.0.0'), identity(' @example/plugin@  >=1.0.0 <2.0.0  '));
  assert.notEqual(identity('@example/plugin@next'), identity('@example/plugin@latest'));
  assert.notEqual(identity('@example/plugin@^1'), identity('@other/plugin@^1'));
  assert.equal(identity('npm:@example/plugin'), 'npm:npm:@example/plugin');
  assert.notEqual(identity('npm:@example/plugin'), identity('@example/plugin'));
});
