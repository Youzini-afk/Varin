# Stored material snapshot tool

An ordinary brokered Host extension contributes one Result tool through `provideTool`.
The manifest is its single tool declaration: cold discovery, activation, input/output validation,
model metadata and inspection use the same service descriptor. The service contract is
`example.material-snapshot.read@1`; the model/policy tool name is `material_snapshot_read`.

Bundle `host.ts` to the manifest's `host.cjs` with the installed extension SDK, then install the
package through the normal extension catalog. Grant its declared `materials.snapshot` Host
capability and select its service provider through normal routing if more than one provider exists.
A ready exact service generation enters the Run's common tool directory at a closed boundary;
a slow or failed preparation does not hold unrelated tools or promise first-request availability.

The handler calls the existing material owner with invocation-scoped capabilities. Core supplies
the original Run source workspace and Thread; the tool cannot choose another authority by passing
IDs. Existing snapshot grants and persisted collections retain their sharing rules. No Pi session,
new material store, URL fetch, document parser or OCR process is created.

`offset` and `maxBytes` are UTF-8 byte positions and budgets. Start at zero and continue with
`nextOffset`; pass the returned `contentHash` as `expectedContentHash` to require the same immutable
revision. A page never splits a codepoint. An offset inside a codepoint or a budget too small for
the next character returns `invalid-range`. Empty stored text is `empty`; the end of nonempty text
is an `ok` page with empty text and `nextOffset: null`. Missing and ungranted snapshots both return
`unavailable`; revision conflicts and detected domain corruption are explicit. Capability denial,
cancellation and storage/transport errors reject rather than becoming a successful empty result.

The response transfer is range-bounded. The native content owner may read the whole immutable
object once to verify its hash, and its existing transport frame limit still applies. A `read`
declaration describes the tool; it does not grant permission or prove an untrusted extension's
side effects absent.
