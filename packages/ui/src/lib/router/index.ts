/**
 * Router module for URL-based navigation in Varin.
 *
 * Provides bidirectional sync between URL query parameters and application state.
 * Works across web and desktop.
 *
 * URL Schema:
 * - `?thread=<id>` - Navigate to specific session
 * - `?directory=<path>` - One-time working-directory hint for a session deep link
 * - `?tab=<chat|git|diff|terminal|files>` - Active main tab
 * - `?settings=<section>` - Open settings to specific section
 * - `?file=<path>` - Diff view with file selected
 *
 * Examples:
 * - `/?thread=abc123` - Open session abc123
 * - `/?thread=abc123&directory=%2Frepo` - Open a session with a cwd hint
 * - `/?tab=git` - Open git tab
 * - `/?settings=providers` - Open settings to providers section
 * - `/?tab=diff&file=src/main.ts` - Open diff view with file
 */

export type { RouteState } from './types';


export { parseRoute, hasRouteParams } from './parseRoute';

export type { AppRouteState } from './serializeRoute';
export {
  updateBrowserURL,
} from './serializeRoute';
