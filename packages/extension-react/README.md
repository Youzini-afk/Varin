# @varin/extension-react

Optional React 19 adapter for Varin Surface extensions. React is a peer dependency and is bundled by
the extension artifact build rather than inherited from the Varin workbench. `defineReactContribution`
and `defineReactReplacement` return framework-neutral mount implementations that create and dispose
their own React root. Uncaught React render errors are reported to the Surface mount host, which removes
that root and shows the contribution seam's built-in fallback. The fallback stays host-owned and is not
passed across React singleton boundaries.

Using React is optional; managed and isolated extensions may use any framework or direct DOM/Canvas.
`defineReactShell`, `defineReactView`, and `defineReactEditor` are typed aliases of the same adapter.
`defineReactTransitionScene` and `useVarinTransitionScene` adapt the stable transition controller
without sharing Varin's own React root or prescribing a Shell DOM structure.
See the complete [authoring guide](https://github.com/Youzini-afk/Varin/blob/main/docs/ops/varin-extension-authoring.md).
