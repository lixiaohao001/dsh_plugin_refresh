/**
 * In-process module replacement for plugin code that is already imported.
 *
 * DeepSeek Harness ships a hot-reload service that swaps module generations,
 * but it only does so for files that fall inside the watched module roots and
 * outside `node_modules`, and a running composition never watches an installed
 * package. As a result a plugin whose files changed at an unchanged path (a
 * re-linked local plugin, a rebuilt bundle, a locally patched package) keeps
 * executing the generation that was imported at startup.
 *
 * This module performs the same replacement on demand for an explicit set of
 * module URLs, using the same steps as `@deepseek-ai/dsh-hmr`:
 *
 * 1. find the live Cordis plugin runtime and the exact fibers that own each URL;
 * 2. drop the Node ESM load-cache and CommonJS require-cache entries for those
 *    files and the rest of their package, keeping the removed jobs for rollback;
 * 3. re-import every target *before* touching live state, so a syntax error
 *    aborts the whole pass with the previous generation still running;
 * 4. delete each old plugin from the registry and re-activate the fresh module
 *    on the same fibers, re-attaching the original Loader `Entry` so entry
 *    identity, config and diagnostics survive the swap.
 *
 * Only the module *files* are replaced. A package whose resolution itself
 * changed (a different directory, a different version installed side by side)
 * is re-resolved by the launcher, not here.
 *
 * @module dsh_plugin_refresh/deep-reload
 */
import { cacheUrls, cachedUrlFor, dropCacheUrl, dropRequireCache, isInsideDirectory, jobOf, loadCacheOf, moduleFileInfo, packageRootOf, resolveModuleUrl, restoreCacheUrl, restoreRequireCache } from './loader-internals.js';

/**
 * @typedef {object} DeepReloadReport
 * @property {string[]} reloaded - Module files whose plugin was replaced.
 * @property {number} purged - Module URLs removed from the ESM/CJS caches.
 * @property {string[]} skipped - Human-readable reasons a target was not replaced.
 * @property {string} [error] - Set when the pass aborted before swapping anything.
 */

/**
 * @typedef {object} PurgeResult
 * @property {number} purged - Module URLs removed from the ESM cache.
 * @property {() => void} restore - Puts every removed job back.
 */

/**
 * Drop cached module generations for a set of files and their package peers.
 *
 * A failed first import leaves its module job in the running Node loader, and
 * re-importing the same URL keeps rejecting until that job is dropped — the
 * reason a plugin whose install failed stays broken until the process
 * restarts. Purging the job lets the next activation read the files again.
 * @param ctx - Owning context; `ctx.loader.internal` must expose the process load cache.
 * @param targetUrls - Module URLs to drop.
 * @returns What was purged and how to undo it.
 */
export function purgeModuleCache(ctx, targetUrls) {
  const cache = loadCacheOf(ctx);
  const urls = [...new Set(targetUrls.filter((url) => typeof url === 'string' && url !== ''))];
  if (!cache || urls.length === 0) return { purged: 0, restore: () => {} };
  const roots = new Set();
  for (const url of urls) {
    const root = packageRootOf(url);
    if (root) roots.add(root);
  }
  const purge = new Set(urls);
  for (const url of cacheUrls(cache)) {
    if (purge.has(url)) continue;
    for (const root of roots) {
      if (isInsideDirectory(url, root)) {
        purge.add(url);
        break;
      }
    }
  }
  const esmBackup = new Map();
  const cjsBackup = [];
  for (const url of purge) {
    const job = dropCacheUrl(cache, url);
    if (job !== undefined) esmBackup.set(url, job);
    const cjs = dropRequireCache(url);
    if (cjs) cjsBackup.push(cjs);
  }
  return {
    purged: esmBackup.size,
    restore: () => {
      for (const [url, job] of esmBackup) restoreCacheUrl(cache, url, job);
      for (const record of cjsBackup) restoreRequireCache(record);
    },
  };
}

/**
 * Read the live plugin runtime and the fibers that must carry a replacement.
 * @param ctx - Owning context.
 * @param cache - Running Node ESM load cache.
 * @param entry - Loader entry to inspect.
 * @returns Fibers to re-activate, or undefined when the entry cannot be swapped.
 */
function generationsOf(ctx, cache, entry, url) {
  const job = jobOf(cache, url);
  const plugin = job?.module ? ctx.loader.unwrapExports(job.module.getNamespace()) : undefined;
  if (!job || plugin === undefined || plugin === null) return undefined;
  const runtime = ctx.registry?.get(plugin);
  const fibers = [...(runtime?.fibers ?? [])].map((fiber) => {
    // The entry's own root fiber is configured by the entry; child fibers carry
    // their own private config. Both are needed to reproduce the activation.
    const owns = fiber.entry?.fiber?.uid === fiber.uid;
    return {
      fiber,
      entry: owns ? fiber.entry : undefined,
      config: owns ? fiber.entry.options.config : fiber._config,
      outerStack: typeof entry.getOuterStack === 'function' ? entry.getOuterStack : () => [],
    };
  });
  if (fibers.length === 0) return undefined;
  return { url, plugin, fibers };
}

/**
 * Replace the module generation behind every listed URL that a live entry owns.
 * @param ctx - Owning context; `ctx.loader.internal` must expose the process load cache.
 * @param targetUrls - Module URLs to replace.
 * @param options - Optional diagnostics sink.
 * @returns A report of what was replaced, purged, skipped, or aborted.
 */
export async function deepReloadModules(ctx, targetUrls, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : () => {};
  /** @type {DeepReloadReport} */
  const report = { reloaded: [], purged: 0, skipped: [] };
  const loader = ctx?.loader;
  const cache = loadCacheOf(ctx);
  if (!loader) {
    report.skipped.push('no Loader service in this context');
    return report;
  }
  if (!cache) {
    report.skipped.push('the running Node loader exposes no module cache');
    return report;
  }

  const wanted = new Set(targetUrls.filter((url) => typeof url === 'string' && url !== ''));
  if (wanted.size === 0) return report;

  const generations = [];
  for (const entry of loader.entries()) {
    if (entry.options?.group || !entry.fiber?.uid) continue;
    const declared = await resolveModuleUrl(loader, entry.options.name, entry.parent?.tree?.ctx?.baseUrl);
    if (!declared || !wanted.has(declared)) continue;
    // The imported URL is what the caches and the live plugin are keyed by; the
    // declared specifier may differ by a query string or a realpath spelling.
    const loaded = cachedUrlFor(cache, declared);
    if (loaded === undefined) {
      report.skipped.push(`${entry.options.id}: the module of ${entry.options.name} is not in the load cache`);
      continue;
    }
    const generation = generationsOf(ctx, cache, entry, loaded);
    if (generation === undefined) {
      report.skipped.push(`${entry.options.id}: no live plugin runtime owns ${entry.options.name}`);
      continue;
    }
    generations.push(generation);
  }
  if (generations.length === 0) return report;

  // Purge the target files and every other cached module inside the same
  // package, so a plugin's own submodules are re-read together with its entry.
  const { purged, restore: rollback } = purgeModuleCache(ctx, [...generations].map(({ url }) => url));
  report.purged = purged;

  const attempts = [];
  try {
    for (const generation of generations) {
      const outerStack = generation.fibers[0]?.outerStack ?? (() => []);
      const replacement = loader.unwrapExports(await loader.import(generation.url, outerStack));
      attempts.push({ ...generation, replacement });
    }
  } catch (error) {
    rollback();
    report.error = `re-import failed: ${error?.message ?? String(error)}`;
    warn(report.error);
    return report;
  }

  for (const attempt of attempts) {
    const path = moduleFileInfo(attempt.url)?.path ?? attempt.url;
    try {
      ctx.registry.delete(attempt.plugin);
    } catch (error) {
      warn(`failed to dispose the previous generation of ${path}: ${error?.message ?? String(error)}`);
    }
    await Promise.allSettled(attempt.fibers.map(({ fiber }) => fiber.await()));
    const activated = [];
    try {
      for (const previous of attempt.fibers) {
        if (previous.fiber.parent.fiber.uid === null) continue;
        const fiber = previous.fiber.parent.registry.plugin(attempt.replacement, previous.config, previous.outerStack).ctx.fiber;
        if (previous.entry !== undefined) {
          // Keep the original Loader entry: identity, config diagnostics and the
          // profile's patch row survive a module swap.
          fiber.entry = previous.entry;
          previous.entry.fiber = fiber;
        }
        activated.push(fiber);
      }
      await Promise.allSettled(activated.map((fiber) => fiber.await()));
      report.reloaded.push(path);
    } catch (error) {
      report.skipped.push(`re-activation failed for ${path}: ${error?.message ?? String(error)}`);
      for (const previous of attempt.fibers) {
        if (previous.fiber.parent.fiber.uid === null) continue;
        try {
          previous.fiber.parent.registry.plugin(attempt.plugin, previous.config, previous.outerStack);
        } catch {
          /* the previous generation is already disposed; nothing else to try */
        }
      }
    }
  }

  try {
    await loader.await();
  } catch {
    /* Loader settlement is best-effort here; activation was already awaited per fiber */
  }
  return report;
}
