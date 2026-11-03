// Packaged renderers do not share their selected Host's origin. Keep this exact
// allowlist shared by HTTP CORS and WebSocket admission; it is not authentication.
// Tauri's CEF document is http://tauri.localhost, with no port or alternate scheme.
const packagedClientOrigins = new Set([
  'varin-ui://app',
  'http://tauri.localhost',
  'capacitor://localhost',
  'https://localhost',
]);

export const isPackagedClientOrigin = (origin: string): boolean => packagedClientOrigins.has(origin);
