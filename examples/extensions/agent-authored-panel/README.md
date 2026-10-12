# Agent-authored text counter

This ordinary package is fixed input for the `extension_package` tool's SourceView capture. The
Host entrypoint imports the single manifest declaration and is bundled by the real Host artifact
builder. The Surface entrypoint is self-contained CommonJS; neither uses a network dependency or a
fabricated builder result. The artifact store performs content-addressed capture and verification.

From a Run whose admitted source contains this directory, stage it with
`{"action":"stage","packagePath":"examples/extensions/agent-authored-panel","expectedRevision":N}`,
using the current catalog revision in place of `N`. A first install remains disabled. Enable and review
it through the existing Extension Manager. It contributes the result-only `authored_text_count` tool
and a framework-neutral panel in the Agent workbench's `workbench.secondary.after` slot.

To update, edit these ordinary files in the same admitted source, increment the manifest version,
and stage again. Apply the exact reviewed candidate with
`{"action":"apply","extensionId":"example.agent-authored-panel","candidateIntegrity":"sha256-…","expectedRevision":N}`.
Use the integrity and revision returned by actual staging/catalog reads. Neither tool grants itself
capabilities or enables the extension.

The Host tool and panel have no mandatory dependency on one another. A closed window does not block
Host selection. An open Surface prepares the selected module and connected mounts independently;
failed activation or mount keeps its prior visible owner, CSS, and asset URLs. That is a Surface
rollback, not a rollback of an already selected Host generation. Updating releases old mount listeners,
DOM, CSS, and object URLs. Disabling or closing the Surface releases its active consumer resources.
