# Bot Appearances & Custom Asset Packs

Each Bot selects its visual appearance under **Settings → Agent → Varin → Profile → Appearance** (and in the Bot side panel). Sidebar, Bot switcher, chat landing, work stage, and mobile headers share this selection. Appearance is purely visual — it never enters prompts or alters model, instructions, memory, or running work.

## Selection & Asset Library

- **Built-in Varin**: Follows the client theme, stays original mist-blue, or uses a fixed per-Bot accent color (recoloring outfit/props only; eyes, hair, skin, and running animation remain intact).
- **Built-in characters**: The appearance picker also includes 15 character presets, each with its own portrait, poses and secondary motion. Presets start in their original palette. Theme and custom colors tint stage effects, particles and props while the character's drawing keeps its palette.
- **Custom uploads**: PNG, JPEG, WebP, GIF preserve original colors (transparent images use natural silhouette; opaque images get rounded frames). Full figure and small avatar support independent X/Y framing and zoom.
- **Apply vs Library**: Importing adds the asset to the Host library immediately (deduplicated by content hash); clicking **Apply** binds it to the Bot independently of unsaved profile drafts. Assets still referenced by active or archived Bots cannot be deleted until reassigned.

## External Appearance Packs (ZIP)

Authors can package images with an `appearance.json` manifest at the ZIP root (paths relative to root, no executable scripts):

```json
{
  "schemaVersion": 1,
  "name": "Moon",
  "image": "images/idle.png",
  "portrait": "images/avatar.png",
  "states": {
    "thinking": "images/thinking.webp",
    "working": "images/working.gif",
    "waiting": "images/waiting.png",
    "sleeping": "images/sleeping.png"
  }
}
```

- Required: `schemaVersion`, `name`, `image`. Optional: `portrait`, `states`.
- Animations: GIF, animated WebP, or APNG (animated only when visible with full motion enabled; avatars and reduced-motion/offscreen views render static frames).
- Optional state keys: `idle`, `listening`, `thinking`, `preparing`, `replying`, `working`, `supervising`, `waiting`, `sleeping`, `waking`, `offline`, `tool-read`, `tool-search`, `tool-web`, `tool-edit`, `tool-shell`, `tool-memory`, `tool-plan`, `tool-other`. Missing states fall back to `image` (tool/reply states may also fall back to `working`).

## Storage & Entrypoints

- **Storage**: The Bot profile stores the appearance selection. Built-in presets store a character ID and an effect color. Custom appearances store an asset reference and framing. Profiles without an appearance keep the default Varin figure. Custom assets are stored as `bot.appearance` records under `__varin_bots__` in Rust Storage, retaining raw media + static preview blobs until unreferenced.
- **HTTP API** (Host-authenticated): `GET/POST /api/harness/bot-appearances` (multipart `file`), `GET/DELETE /api/harness/bot-appearances/:id`, `GET .../media/:hash`. Clients consume via `BotsAPI.appearances`.
- **Stage & Companion**: Built-in characters share the production stage rig. Small avatars use compact portraits, and full character artwork loads when a stage or welcome figure needs it. Group chat uses the chosen figure in member details and the chosen portrait in messages and member lists. Custom images render on a separate stage. Desktop companion assets stay independent of Bot appearances.
- **Code**: [bot-appearance.ts](../packages/application-client/src/bot-appearance.ts) · [bot-appearances.ts](../packages/web/application-host/lib/bots/bot-appearances.ts) · `packages/ui/src/workbenches/bot/BotFigure.tsx`.
