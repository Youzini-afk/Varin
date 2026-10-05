# Settings UI composition

The components in this directory are the shared composition layer for Settings pages. They encode the
current hierarchy, pane-relative responsiveness, accessibility behavior, search anchors, and ordinary
save feedback so individual pages do not need a second page system.

## Layout and hierarchy

`SettingsPageLayout` owns scrolling, page width/padding, the container-query scope, the page header,
and optional save status. Settings content responds to the pane through `@xl` / `@3xl` container
queries; viewport breakpoints describe outer application chrome, not the width of a nested Settings
pane.

`SettingsSection` is the page's section boundary. `SettingsControlGroup` is a sub-cluster within a
section; `SettingsFieldRow` places a label beside a control cluster, while `SettingsStackedField` is
the label-above shape used for wide controls and `SettingsTwoColumn` cells. The exported constants in
`SettingsSection.tsx` are the maintained control widths, typography levels, and spacing values.

Boolean, exclusive-choice, and short segmented-choice controls use `SettingsCheckboxRow`,
`SettingsRadioGroup` / `SettingsRadioOption`, and `SettingsChipGroup`. These primitives already carry
keyboard and accessibility behavior. `SettingsInfoHint` is the hover-and-click helper disclosure used
by the `info` props, including touch devices where hover alone is unavailable.

The shared `Select` supplies inline `SelectItem` labels to Base UI before its popup mounts. A plain
`SelectValue` shows the same localized label as the menu; configuration values remain their native
IDs. Explicit `items`, value children and custom value renderers retain their caller-owned display.

Explanatory prose can stay behind `info` so the default page remains scannable. Text needed to make a
current operation safe or usable—validation errors, destructive consequences, security warnings,
required syntax, dynamic state, and active wizard instructions—remains visible.

## Persistence feedback

`SettingsPageLayout showSaveStatus` observes the shared persistence state. Fast successful writes stay
quiet, slower writes show the delayed saving indicator, and failures remain visible. Settings saved
through the shared persistence path get this behavior automatically; a page-specific authority reports
its state through `@/lib/persistence` rather than inventing a second success/error badge system.

## Search projection

Settings search is an explicit projection, not a scrape of rendered JSX:

- `src/lib/settings/search.ts` owns stable searchable items and conditional item availability.
- `src/lib/settings/metadata.ts` owns page metadata and page-level availability.
- A rendered target exposes the matching `data-settings-item`; the shared primitives accept this as
  `settingsItem`.
- `SettingsView.tsx` owns navigation order, while `MobileApp.tsx` owns the mobile page set.

Static controls, section headings, and predictable create/connect actions are useful search targets.
Rows for dynamic agents, projects, providers, hosts, sessions, or packages are normally discovered
inside their page instead of becoming an unbounded global index. When a result requires selected
entity state or a draft editor, `prepareSettingsSearchTarget` prepares that state before highlight.
Availability in the registry should describe the same runtime/platform condition as the rendered
control.
