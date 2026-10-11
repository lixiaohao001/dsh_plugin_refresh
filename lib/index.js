/**
 * dsh_plugin_refresh — DeepSeek Harness host plugin.
 *
 * Installing a plugin into a DSH profile is a package operation followed by a
 * composition change. DeepSeek Harness applies that change in-process when the
 * hot-reload service is composed, but three real cases still end in "takes
 * effect at the next start":
 *
 * - the install named a dependency the profile already had, so the manager
 *   deliberately stops before reloading;
 * - the composition came from outside the manager (the CLI, an editor, the
 *   Desktop shell, a hand-edited patch), where only the HMR watch would notice;
 * - the plugin's own files changed at an unchanged path (a re-linked local
 *   plugin, a rebuilt bundle), which no watcher covers because installed
 *   packages live under `node_modules`.
 *
 * This plugin closes those gaps without re-implementing any profile write:
 *
 * 1. it watches the profile layers and any configured development paths;
 * 2. after every plugin-manager operation it verifies the bundles that
 *    operation could have left unmounted and re-drives them through
 *    `pluginManager.setBundleEnabled`, the same typed path the Web Plugins
 *    page uses (writer lock, HMR queue and Loader settlement included);
 * 3. it deep-reloads live plugins whose module files changed at the same path,
 *    using the same cache-purge plus re-import plus fiber re-attachment steps
 *    the official hot-reload service uses;
 * 4. it reports the result through the log and a read-only status route.
 *
 * Nothing here mutates the profile's package manifest or patch files, so the
 * plugin is inert when everything already works.
 *
 * @module dsh_plugin_refresh
 */
import { Config, resolveConfig } from './config.js';
import { RefreshEngine } from './engine.js';
import { registerRoutes } from './routes.js';

/** Plugin identity used in Loader diagnostics and the registry. */
export const name = 'plugin-refresh';

/**
 * Required services.
 *
 * Empty by design: every service this plugin uses (`hmr`, `pluginManager`,
 * `profileContext`, `webServer`, `appReady`) is optional, because the plugin
 * must load in a composition that has none of them — that is exactly the
 * degenerate case it exists to report on.
 */
export const inject = [];

export { Config };

/**
 * Mount the refresh engine.
 * @param ctx - The row's context.
 * @param config - Row config, validated by {@link Config} when supplied.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const engine = new RefreshEngine(ctx, resolved);

  ctx.effect(() => () => engine.dispose(), 'plugin-refresh: engine');
  registerRoutes(ctx, engine, resolved);
  subscribe(ctx, engine, resolved);
  startWhenReady(ctx, engine);
}

/**
 * Wire the engine to the composition and package events it reacts to.
 * @param ctx - The row's context.
 * @param engine - The refresh engine.
 * @param config - Resolved config.
 */
function subscribe(ctx, engine, config) {
  if (config.autoCheck) {
    ctx.on('plugin-manager/changed', (change) => {
      // Our own repair goes through the manager, which emits this event inside
      // its transaction. Reacting to it would schedule the next repair pass.
      if (engine.repairing) return;
      const reason = `plugin-manager:${change?.reason ?? 'change'}`;
      // A removal only changes what is running; a pass reports it and reloads
      // stale modules, and the manager has already unloaded the bundle.
      engine.schedule(reason, config.debounceMs, { manage: true });
    });
    ctx.on('plugin-manager/install-state', (progress) => {
      // `applying` is announced before selection and reload; give the manager
      // time to finish its own transaction before verifying the outcome.
      if (progress?.phase === 'applying') engine.schedule('install-applying', config.debounceMs + 1500, { manage: true });
    });
  }
  // A recomposition rewires the tree; refresh which entries and files are
  // tracked, without adopting fingerprints for edits no pass has acted on yet.
  const resnapshot = (label) => () => {
    engine.captureSnapshot({ merge: true }).catch((error) => {
      ctx.logger?.debug?.(`[plugin-refresh] snapshot after ${label} failed: ${error?.message ?? String(error)}`);
    });
  };
  ctx.on('app-boot/config-reload', resnapshot('config-reload'));
  ctx.on('hmr/reload', resnapshot('hmr-reload'));
}

/**
 * Start the engine once the application is ready.
 *
 * `appReady` is the launcher's readiness service; the HMR service itself waits
 * for it before processing anything, so checks scheduled before readiness
 * would race the boot. When the service is absent the engine starts at once.
 * @param ctx - The row's context.
 * @param engine - The refresh engine.
 */
function startWhenReady(ctx, engine) {
  const launch = () => {
    engine.start().catch((error) => {
      ctx.logger?.warn?.(`[plugin-refresh] startup check failed: ${error?.message ?? String(error)}`);
    });
  };
  const ready = ctx.get?.('appReady');
  if (ready && typeof ready.onReady === 'function') {
    try {
      ready.onReady(launch);
      return;
    } catch {
      /* fall through to an immediate start */
    }
  }
  launch();
}
