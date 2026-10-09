# @varin/extension-host

Trusted application-host ownership for the Varin extension catalog.

The host stores manifests, installation records, desired state, capability grants, application-host
identity, and truthful diagnostics. It materializes npm, Git, local-directory, and registered built-in
sources without lifecycle scripts; managed Surface entrypoints are bundled into immutable SHA-256
artifacts. Selected and candidate versions remain separate until a Surface activation transaction
successfully selects the candidate with a catalog revision precondition.

Published extensions can point a managed entrypoint at a self-contained `.cjs` browser bundle; it is
copied verbatim and works in hosts that intentionally do not ship a source compiler. Other supported
source entrypoints are bundled by the application host with esbuild.

The host serves verified artifact bytes through authenticated Runtime API operations. Public catalog
responses never expose source specifiers or resolved filesystem paths, and asset responses never put
credentials in module or resource URLs. Brokered and explicitly trusted-native Host entrypoints use
generation-scoped lifecycle ownership, versioned services, revisioned storage, candidate rollback,
and persisted multi-scope service routing.

Distribution-owned Host extensions use the same immutable artifact and broker lifecycle as installed
extensions. Their requested Host capabilities are granted only while reconciling the distribution
definition; executable artifacts are materialized lazily when their activation event is first requested,
so declarative built-ins do not add startup I/O.

Language activation carries the requested language ID. The distribution's provider catalog identifies
which built-in extension owns it, so opening a TypeScript document does not first prepare the unrelated
Python and other language pack. Third-party extensions retain their declared workspace activation.

Built-in source directories are read-only distribution assets. Preparation copies them once into the
managed immutable artifact; it does not first duplicate the whole package into another temporary source
tree or install missing dependencies into the application directory.

Registered built-in package roots must identify physical directories that the Host can canonicalize and
copy. Archive-backed distributions resolve their logical module address to the corresponding unpacked
directory before constructing the package manager; brokered processes are launched only from the
resulting immutable artifact, never from an application archive.

Host activation is serialized per extension owner, not across the catalog. Dependency preparation
resolves before owner admission; concurrent consumers reuse the provider generation after its
preparation finishes. Independent startup and retirement proceed in parallel. A canceled or stale
preparation cannot publish, and shutdown closes admission before aborting unpublished broker owners.
Service publication reserves only conflicting declared single-provider services during storage/catalog
commit; registry publication itself is synchronous. Retired generations still drain their pinned calls
before transport disposal. Failed replacement routing rollback touches only selections it changed.
