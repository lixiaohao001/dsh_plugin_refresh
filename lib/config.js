/**
 * Configuration for `dsh_plugin_refresh`.
 *
 * The plugin deliberately has no package dependency: a locally linked plugin
 * (`pnpm add <path>` → `link:`) resolves its bare imports from its real
 * location, which is outside both the profile and the app tree, so
 * `@deepseek-ai/*` specifiers are unreachable from there. The schema below is
 * therefore built from `@deepseek-ai/schemastery` only when that package is
 * reachable, and the row falls back to raw config (normalized by
 * {@link resolveConfig}) when it is not.
 *
 * @module dsh_plugin_refresh/config
 */

/**
 * Schema factory, or undefined when the schema library is unreachable.
 * @type {any}
 */
let schemastery;
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default;
} catch {
  schemastery = undefined;
}

/** Defaults shared by the schema and the manual resolver. */
export const CONFIG_DEFAULTS = Object.freeze({
  autoCheck: true,
  autoRepair: true,
  deepReload: true,
  watchProfile: true,
  devWatch: [],
  devReload: true,
  pollIntervalMs: 2000,
  debounceMs: 400,
  startupDelayMs: 1200,
  route: '/api/plugin-refresh',
  verbose: false,
});

/** One schema field per behavior this plugin offers. */
const FIELDS = {
  autoCheck: ['check', 'Check the installed composition after startup and after every plugin-manager operation.'],
  autoRepair: ['repair', 'Re-drive the profile composition through the plugin manager when a bundle that was just installed or enabled has no running plugin row.'],
  deepReload: ['reload', 'Reload already-imported plugin modules whose files changed on disk, so a rebuilt or re-linked plugin takes effect without restarting the process.'],
  watchProfile: ['watch', 'Watch the profile patch files and manifest so composition edits made outside this process still activate.'],
  devWatch: ['dev', 'Absolute files or directories watched for plugin development; a change deep-reloads the plugin that owns the changed file.'],
  devReload: ['dev', 'Perform the deep reload when a `devWatch` path changes.'],
  pollIntervalMs: ['ms', 'Interval of the fingerprint poll that backs up file watching; 0 disables it. A pass compares recorded size and modification time only, so it is cheap.'],
  debounceMs: ['ms', 'Quiet window used to combine bursts of change events into one pass.'],
  startupDelayMs: ['ms', 'Delay after application readiness before the first automatic check.'],
  route: ['http', 'Prefix of the status route; an empty string disables the HTTP surface.'],
  verbose: ['log', 'Log every check step, including passes that found nothing to do.'],
};

/**
 * The row's schema, exported only when the schema library resolved.
 *
 * An absent `Config` is a supported plugin shape: the Loader then passes the
 * row's raw `config` straight to `apply()`.
 */
export const Config = schemastery === undefined ? undefined : buildConfig(schemastery);

/**
 * Build the Config schema.
 * @param z - The schemastery module.
 * @returns The row schema.
 */
function buildConfig(z) {
  return z.object({
    autoCheck: z.boolean().default(CONFIG_DEFAULTS.autoCheck).description(FIELDS.autoCheck[1]),
    autoRepair: z.boolean().default(CONFIG_DEFAULTS.autoRepair).description(FIELDS.autoRepair[1]),
    deepReload: z.boolean().default(CONFIG_DEFAULTS.deepReload).description(FIELDS.deepReload[1]),
    watchProfile: z.boolean().default(CONFIG_DEFAULTS.watchProfile).description(FIELDS.watchProfile[1]),
    devWatch: z.array(String).role('table').default([]).description(FIELDS.devWatch[1]),
    devReload: z.boolean().default(CONFIG_DEFAULTS.devReload).description(FIELDS.devReload[1]),
    pollIntervalMs: z.natural().role('ms').default(CONFIG_DEFAULTS.pollIntervalMs).description(FIELDS.pollIntervalMs[1]),
    debounceMs: z.natural().role('ms').default(CONFIG_DEFAULTS.debounceMs).description(FIELDS.debounceMs[1]),
    startupDelayMs: z.natural().role('ms').default(CONFIG_DEFAULTS.startupDelayMs).description(FIELDS.startupDelayMs[1]),
    route: z.string().default(CONFIG_DEFAULTS.route).description(FIELDS.route[1]),
    verbose: z.boolean().default(CONFIG_DEFAULTS.verbose).description(FIELDS.verbose[1]),
  });
}

/**
 * Fill defaults for a config object that did not go through the schema.
 * @param config - Raw config from the Loader, if any.
 * @returns A complete config object.
 */
export function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const merged = { ...CONFIG_DEFAULTS, ...source };
  if (!Array.isArray(merged.devWatch)) merged.devWatch = [];
  merged.devWatch = merged.devWatch.filter((path) => typeof path === 'string' && path !== '');
  for (const key of ['debounceMs', 'startupDelayMs', 'pollIntervalMs']) {
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) && value >= 0 ? value : CONFIG_DEFAULTS[key];
  }
  if (typeof merged.route !== 'string') merged.route = CONFIG_DEFAULTS.route;
  return merged;
}

/** Whether the row exposes a real schemastery schema to the Loader. */
export const HAS_SCHEMA = schemastery !== undefined;
