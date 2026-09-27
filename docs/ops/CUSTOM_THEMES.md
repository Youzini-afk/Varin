# Custom Themes

Varin supports user-defined themes. Drop a JSON file into the Varin data directory's `themes`
folder and reload it without restarting the application.

## Quick start

1. Create the themes directory:
   ```bash
   mkdir -p ~/.config/varin/themes
   ```

2. Create a theme JSON file (e.g., `my-theme.json`) with the format below.

3. In Varin: **Settings → Appearance → Reload themes**.

4. Select your theme from the dropdown.

Built-in theme names and style descriptions follow the interface language. Original palette names
remain recognizable, and the picker previews each variant's actual background, primary accent and
syntax colors. Custom names/descriptions remain author-owned; changing the interface language never
rewrites theme JSON or stored theme IDs.

## Surfaces and accents

Each palette defines its own `surface`, `primary`, `interactive`, `status`, and `syntax` colors.
Switching themes selects all of them together; an accent is not a global tint applied to the UI.
Keep background hierarchy and readable text in `surface`, prominent actions in `primary`, and
hover/selection/focus in `interactive`. A theme can retain warm, cool, or ink-like surfaces without
using its primary accent as every panel background. Error/success and code colors retain their own
meaning. Light and dark variants need their own contrast choices rather than identical accent values.

Built-in palettes share neutral work surfaces and text, with distinct accent and syntax colors. The
accent remains visible in primary buttons, softly tinted selected rows/chips and focus indicators;
it does not wash over whole panels. User messages use a raised neutral background. Markdown headings,
inline code and list markers use surface text, while links and syntax remain independently colored.
Tool results use opaque muted surfaces rather than stacking translucent tints. Interface typography
stays consistent when switching built-in themes; code keeps its monospace font. Secondary text and solid-action labels are tuned for
at least 4.5:1 contrast against their defined surfaces, including the action hover/active states.
Custom palettes retain their explicit surface, component and font overrides.

## Theme location

| Platform | Default path |
|----------|--------------|
| Windows | `%APPDATA%\Varin\themes\` |
| macOS | `~/Library/Application Support/Varin/themes/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/varin/themes/` |

When `VARIN_DATA_DIR` is set, the authoritative location on every platform is
`$VARIN_DATA_DIR/themes`. The server process that owns the current application host reads this
directory; a remote browser or mobile client does not read themes from its own device.

## Theme format

```json
{
  "metadata": {
    "id": "my-custom-theme",
    "name": "My Custom Theme",
    "description": "A custom theme for Varin",
    "version": "1.0.0",
    "variant": "dark",
    "tags": ["dark", "custom"]
  },
  "colors": {
    "primary": {
      "base": "#EC8B49",
      "hover": "#DA702C",
      "active": "#F9AE77",
      "foreground": "#100F0F",
      "muted": "#EC8B4980",
      "emphasis": "#F9AE77"
    },
    "surface": {
      "background": "#100F0F",
      "foreground": "#CECDC3",
      "muted": "#1C1B1A90",
      "mutedForeground": "#878580",
      "elevated": "#1C1A1990",
      "elevatedForeground": "#CECDC3",
      "overlay": "#00000080",
      "subtle": "#1e1d1c"
    },
    "interactive": {
      "border": "#343331",
      "borderHover": "#403E3C",
      "borderFocus": "#EC8B49",
      "selection": "#f4f4f41f",
      "selectionForeground": "#CECDC3",
      "focus": "#EC8B49",
      "focusRing": "#EC8B4950",
      "cursor": "#CECDC3",
      "hover": "#ffffff18",
      "active": "#ffffff1f"
    },
    "status": {
      "error": "#D14D41",
      "errorForeground": "#100F0F",
      "errorBackground": "#AF302920",
      "errorBorder": "#AF302950",
      "warning": "#DA702C",
      "warningForeground": "#100F0F",
      "warningBackground": "#BC521520",
      "warningBorder": "#BC521550",
      "success": "#A0AF54",
      "successForeground": "#100F0F",
      "successBackground": "#66800B20",
      "successBorder": "#66800B50",
      "info": "#4385BE",
      "infoForeground": "#100F0F",
      "infoBackground": "#205EA620",
      "infoBorder": "#205EA650"
    },
    "pr": {
      "open": "#A0AF54",
      "draft": "#878580",
      "blocked": "#DA702C",
      "merged": "#8B7EC8",
      "closed": "#D14D41"
    },
    "syntax": {
      "base": {
        "background": "#1C1B1A",
        "foreground": "#CECDC3",
        "comment": "#878580",
        "keyword": "#4385BE",
        "string": "#3AA99F",
        "number": "#8B7EC8",
        "function": "#DA702C",
        "variable": "#CECDC3",
        "type": "#D0A215",
        "operator": "#D14D41"
      },
      "tokens": {
        "commentDoc": "#575653",
        "stringEscape": "#CECDC3",
        "keywordImport": "#D14D41",
        "storageModifier": "#4385BE",
        "functionCall": "#DA702C",
        "method": "#879A39",
        "variableProperty": "#4385BE",
        "variableOther": "#879A39",
        "variableGlobal": "#CE5D97",
        "variableLocal": "#282726",
        "parameter": "#CECDC3",
        "constant": "#CECDC3",
        "class": "#DA702C",
        "className": "#DA702C",
        "interface": "#D0A215",
        "struct": "#DA702C",
        "enum": "#DA702C",
        "typeParameter": "#DA702C",
        "namespace": "#D0A215",
        "module": "#D14D41",
        "tag": "#4385BE",
        "jsxTag": "#CE5D97",
        "tagAttribute": "#D0A215",
        "tagAttributeValue": "#3AA99F",
        "boolean": "#D0A215",
        "decorator": "#D0A215",
        "label": "#CE5D97",
        "punctuation": "#878580",
        "macro": "#4385BE",
        "preprocessor": "#CE5D97",
        "regex": "#3AA99F",
        "url": "#4385BE",
        "key": "#DA702C",
        "exception": "#CE5D97"
      },
      "highlights": {
        "diffAdded": "#879A39",
        "diffAddedBackground": "#66800B20",
        "diffRemoved": "#D14D41",
        "diffRemovedBackground": "#AF302920",
        "diffModified": "#4385BE",
        "diffModifiedBackground": "#205EA620",
        "lineNumber": "#403E3C",
        "lineNumberActive": "#CECDC3"
      }
    },
    "markdown": {
      "heading1": "#fbf9e6",
      "heading2": "#e6e4d2",
      "heading3": "#CECDC3",
      "heading4": "#CECDC3",
      "link": "#4385BE",
      "linkHover": "#205EA6",
      "inlineCode": "#A0AF53",
      "inlineCodeBackground": "#1C1B1A",
      "blockquote": "#878580",
      "blockquoteBorder": "#343331",
      "listMarker": "#D0A21599"
    },
    "chat": {
      "userMessage": "#CECDC3",
      "userMessageBackground": "#2d1d15",
      "assistantMessage": "#CECDC3",
      "assistantMessageBackground": "#100F0F",
      "timestamp": "#878580",
      "divider": "#343331"
    },
    "tools": {
      "background": "#1C1B1A50",
      "border": "#42403e9d",
      "headerHover": "#34333150",
      "icon": "#aca7a1",
      "title": "#CECDC3",
      "description": "#878580",
      "edit": {
        "added": "#879A39",
        "addedBackground": "#66800B25",
        "removed": "#D14D41",
        "removedBackground": "#AF302925",
        "lineNumber": "#403E3C"
      }
    }
  },
  "config": {
    "fonts": {
      "sans": "\"IBM Plex Mono\", monospace",
      "mono": "\"IBM Plex Mono\", monospace",
      "heading": "\"IBM Plex Mono\", monospace"
    },
    "radius": {
      "none": "0",
      "sm": "0.325rem",
      "md": "0.75rem",
      "lg": "1.125rem",
      "xl": "1.5rem",
      "full": "9999px"
    },
    "transitions": {
      "fast": "150ms ease",
      "normal": "250ms ease",
      "slow": "350ms ease"
    }
  }
}
```

## Surface alpha requirement

- `colors.surface.muted` and `colors.surface.elevated` must always use 90 alpha (`...90` in 8-digit hex, e.g. `#1C1B1A90`).

## Validation

Themes are validated on load. Invalid themes are skipped with a console warning.

Common issues:
- Missing required fields
- Invalid `variant` (must be `"light"` or `"dark"`)
- File size > 512KB

## Tips

- Use hex with alpha for transparency (e.g., `#FFFFFF20`)
- Reference built-in themes in `packages/ui/src/lib/theme/themes/` for more examples
- Theme `id` must be unique; duplicates are skipped
