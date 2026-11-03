# @varin/extension-react

Optional React 19 adapter for Varin Surface extensions. React is a peer dependency and is bundled by
the extension artifact build rather than inherited from the Varin workbench. `defineReactContribution`
and `defineReactReplacement` return framework-neutral mount implementations that create and dispose
their own React root. Uncaught React render errors are reported to the Surface mount host, which removes
that root and shows the contribution seam's built-in fallback. The fallback stays host-owned and is not
passed across React singleton boundaries.

Using React is optional; managed and isolated extensions may use any framework or direct DOM/Canvas.
`defineReactView` and `defineReactEditor` alias the same adapter. `defineReactShell` additionally
provides the mount's `VarinWorkbenchCompositionHost` as a `workbench` prop and through
`useWorkbenchCompositionHost()`. That hook returns null outside a Shell mount; child composition
uses the Shell's declared seams, not private product UI imports.
`defineReactTransitionScene` and `useVarinTransitionScene` adapt the stable transition controller
without sharing Varin's own React root or prescribing a Shell DOM structure.
See the complete [authoring guide](https://github.com/Youzini-afk/Varin/blob/main/docs/ops/varin-extension-authoring.md).

`defineReactSettingsPage` adapts the public settings `region` props. `defineReactMessageRenderer`,
`defineReactToolRenderer`, and `defineReactSessionDecoration` take a `matches` predicate and a component.
They use the same extension-owned root and lifecycle; matching receives read-only presentation rather
than a runtime owner. These same-realm adapters do not serialize callbacks across isolated realms.
