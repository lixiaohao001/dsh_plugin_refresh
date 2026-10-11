/**
 * The refresh engine: one serialized pass that keeps a running composition
 * equal to what is installed on disk.
 *
 * A pass does three things, in this order:
 *
 * 1. **Deep reload** — any live plugin whose module file changed at its
 *    unchanged path is re-imported and re-activated in place (see
 *    `deep-reload.js`). This is what makes a rebuilt or re-linked plugin take
 *    effect without restarting the process.
 * 2. **Repair** — when a plugin-manager operation named a bundle that just
 *    became selected, and none of that bundle's rows is running, the pass
 *    re-drives the composition through `pluginManager.setBundleEnabled`, the
 *    same typed path the Web Plugins page uses. That call takes the profile
 *    writer lock and the HMR queue itself, so nothing here re-implements
 *    profile writing.
 * 3. **Report** — a health snapshot of every bundle (selected, active rows,
 *    error) that the status route and the log both consume.
 *
 * All three run inside `hmr.runExclusive` when the hot-reload service exists,
 * which is what keeps them ordered against the HMR service's own reloads.
 *
 * @module dsh_plugin_refresh/engine
 */
import { readFileSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deepReloadModules, purgeModuleCache } from './deep-reload.js';
import { cachedUrlFor, isInsideDirectory, jobOf, loadCacheOf, moduleFileInfo, packageRootOf, resolveModuleUrl } from './loader-internals.js';

/** Maximum number of recent passes kept for the status route. */
const HISTORY_LIMIT = 25;

/**
 * Minimum spacing between repair attempts for one bundle.
 *
 * A repair makes the plugin manager emit `plugin-manager/changed`, which is the
 * very signal that schedules the next pass. Without a cooldown a bundle that
 * cannot activate (an incompatible version, a missing peer) would be repaired
 * for ever; one attempt per window keeps the loop bounded and leaves the
 * outcome visible in the pass history.
 */
const REPAIR_COOLDOWN_MS = 15_000;

/**
 * Serialized composition checks and repairs.
 */
export class RefreshEngine {
  /** @type {Map<string, { url: string, mtimeMs: number, size: number, path: string, name: string }>} */
  #snapshot = new Map();
  /** @type {Set<NodeJS.Timeout>} */
  #timers = new Set();
  /** @type {Array<import('node:fs').FSWatcher>} */
  #watchers = [];
  /** @type {Array<{ target: string, directory: string, recursive: boolean, changes: number }>} */
  #watched = [];
  /** @type {NodeJS.Timeout | undefined} */
  #pollTimer;
  /** Fingerprint polls completed by this engine. */
  #polls = 0;
  /** True while a repair is driving the plugin manager, whose own event must not re-enter. */
  #repairing = false;
  /** @type {Map<string, number>} */
  #repairAttempts = new Map();

  /** Whether a repair is currently driving the plugin manager. */
  get repairing() {
    return this.#repairing;
  }

  /**
   * Identity of this engine instance and when it started.
   *
   * A deep reload replaces the running plugin, so the status document is served
   * by a new engine afterwards. Watching this value change is the direct proof
   * that an edit was picked up without restarting the process.
   */
  generation = `g${Math.random().toString(16).slice(2, 8)}`;
  startedAt = Date.now();
  /** @type {Promise<unknown>} */
  #chain = Promise.resolve();
  /** @type {object[]} */
  #history = [];
  #lastResult;
  #disposed = false;
  /** Bundle names the process started with; these are never auto-repaired. */
  #startedBundles = new Set();
  /** Bundle names last observed in the profile manifest. */
  #knownBundles = new Set();

  /**
   * @param ctx - The plugin's context.
   * @param config - Resolved config from `config.js`.
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }

  /**
   * Build the initial module snapshot, install file watches, and schedule the
   * first automatic check.
   * @returns The initial snapshot size.
   */
  async start() {
    const profile = this.ctx.get?.('profileContext');
    for (const name of profile?.startedBundles ?? []) this.#startedBundles.add(name);
    this.#knownBundles = new Set(this.readSelectedBundles());
    this.#installWatches();
    await this.captureSnapshot();
    this.schedule('startup', this.config.startupDelayMs);
    return this.#snapshot.size;
  }

  /** Close watchers and drop pending timers. Idempotent. */
  dispose() {
    this.#disposed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    for (const watcher of this.#watchers) {
      try {
        watcher.close();
      } catch {
        /* an already-closed watcher needs no further handling */
      }
    }
    this.#watchers = [];
  }

  /**
   * Queue one pass after a quiet window; repeated calls inside the window
   * collapse into a single pass.
   * @param reason - Short label recorded in the pass result.
   * @param delay - Override for the configured debounce.
   * @param options - Pass options (`bundle`, `deepReload`).
   */
  schedule(reason, delay, options = {}) {
    if (this.#disposed) return;
    const wait = typeof delay === 'number' ? delay : this.config.debounceMs;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.run(reason, options).catch(() => undefined);
    }, Math.max(0, wait));
    if (typeof timer.unref === 'function') timer.unref();
    this.#timers.add(timer);
  }

  /**
   * Run one pass, serialized behind any pass already in flight.
   * @param reason - Short label recorded in the pass result.
   * @param options - `bundle` names one bundle to verify and repair.
   * @returns The pass result.
   */
  run(reason, options = {}) {
    const task = this.#chain.then(
      () => this.#execute(reason, options),
      () => this.#execute(reason, options),
    );
    this.#chain = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * Snapshot every live entry's module files for change detection.
   *
   * A plugin's behavior lives in its whole module graph, not in its entry file:
   * editing `lib/engine.js` while `lib/index.js` is untouched must still be
   * noticed. Only files inside the entry's own package are recorded, so an
   * unrelated package's edit never triggers a reload of this entry.
   * @param options - `merge: true` refreshes the tracked *set* of entries and
   * files while keeping fingerprints already observed, so a tree change cannot
   * absorb an edit that no pass has acted on yet.
   * @returns The new snapshot.
   */
  async captureSnapshot(options = {}) {
    const loader = this.ctx.loader;
    const previous = this.#snapshot;
    const next = new Map();
    if (loader) {
      for (const entry of loader.entries()) {
        if (entry.options?.group || !entry.fiber?.uid) continue;
        const url = await resolveModuleUrl(loader, entry.options.name, entry.parent?.tree?.ctx?.baseUrl);
        if (!url) continue;
        const files = await this.#moduleFiles(url);
        if (files.length === 0) continue;
        next.set(entry.options.id ?? entry.id, { url, name: entry.options.name, files });
      }
    }
    if (options.merge === true) {
      for (const [key, entry] of next) {
        const before = previous.get(key);
        if (before === undefined) continue;
        const observed = new Map(before.files.map((file) => [file.path, file]));
        for (const file of entry.files) {
          const earlier = observed.get(file.path);
          if (earlier === undefined) continue;
          file.url = earlier.url;
          file.size = earlier.size;
          file.mtimeMs = earlier.mtimeMs;
        }
      }
    }
    this.#snapshot = next;
    return next;
  }

  /**
   * Collect the files of one module graph that belong to its own package.
   * @param url - Entry module URL.
   * @returns Stat records, entry file first.
   */
  async #moduleFiles(url) {
    const cache = loadCacheOf(this.ctx);
    // The graph lives under the URL the module was imported as, which a
    // cache-busted or re-spelled specifier may not equal.
    const loaded = cachedUrlFor(cache, url) ?? url;
    const root = packageRootOf(loaded);
    const seen = new Set();
    const files = [];
    const visit = async (target, depth) => {
      if (seen.has(target) || seen.size > 2000 || depth > 32) return;
      seen.add(target);
      if (target.startsWith('node:')) return;
      if (root === undefined || isInsideDirectory(target, root)) {
        const info = moduleFileInfo(target);
        if (info) files.push({ url: target, path: info.path, size: info.size, mtimeMs: info.mtimeMs });
      }
      for (const child of await this.#linked(target)) await visit(child, depth + 1);
    };
    await visit(loaded, 0);
    return files;
  }

  /**
   * Read a module's direct dependencies from the running Node loader.
   *
   * The load cache is read directly rather than through `ctx.hmr.getLinked`:
   * on Node 22 a cache value is a per-format record (`{ javascript: ModuleJob }`),
   * so the HMR helper's `job.linked` is undefined there and it throws instead of
   * returning the graph. `jobOf` unwraps both loader shapes.
   * @param url - Module URL.
   * @returns Linked module URLs, or an empty list when unknown.
   */
  async #linked(url) {
    const job = jobOf(loadCacheOf(this.ctx), url);
    if (job?.linked !== undefined) {
      try {
        const children = await job.linked;
        return Array.prototype.map.call(children, (child) => child?.url).filter((child) => typeof child === 'string');
      } catch {
        /* fall through to the service helper */
      }
    }
    const hmr = this.ctx.get?.('hmr');
    if (hmr && typeof hmr.getLinked === 'function') {
      try {
        return await hmr.getLinked(url);
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Module URLs whose file changed since the last snapshot, directly or
   * anywhere in their own package's graph.
   * @returns Distinct entry module URLs.
   */
  staleUrls() {
    const stale = new Set();
    for (const previous of this.#snapshot.values()) {
      const changed = previous.files.some((file) => {
        const info = moduleFileInfo(file.url);
        if (!info) return true;
        return info.mtimeMs !== file.mtimeMs || info.size !== file.size;
      });
      if (changed) stale.add(previous.url);
    }
    return [...stale];
  }

  /**
   * Row ids that currently have a running fiber.
   * @returns Set of live entry ids.
   */
  activeRowIds() {
    const ids = new Set();
    for (const entry of this.ctx.loader?.entries() ?? []) {
      if (entry.fiber?.uid && typeof entry.options?.id === 'string') ids.add(entry.options.id);
    }
    return ids;
  }

  /**
   * Read the plugin manager's bundle table when the service is composed.
   * @returns Bundle list, or an empty list when unavailable.
   */
  async listBundles() {
    const manager = this.ctx.get?.('pluginManager');
    if (!manager || typeof manager.listBundles !== 'function') return undefined;
    return await manager.listBundles();
  }

  /**
   * Whether a bundle has a selected row set that produced no running plugin.
   *
   * Rows switched off by a patch layer are excluded: `enabled` records the saved
   * selection, not load success, and a deliberately disabled row (a skin another
   * skin replaced, a preset-scoped tool) is not a failure to repair.
   * @param bundle - One row from `pluginManager.listBundles()`.
   * @returns True when the bundle looks installed but not mounted.
   */
  needsRepair(bundle) {
    if (!bundle || bundle.enabled !== true) return false;
    const rows = Array.isArray(bundle.rows) ? bundle.rows : [];
    if (rows.length === 0) return false;
    const off = this.#disabledRowIds();
    const candidates = rows.filter((row) => !off.has(row.rowId));
    if (candidates.length === 0) return false;
    if (bundle.error !== undefined) return true;
    const live = this.activeRowIds();
    return candidates.every((row) => !live.has(row.rowId));
  }

  /**
   * Row ids whose Loader entry is switched off, by itself or by an ancestor.
   * @returns Set of disabled entry ids.
   */
  #disabledRowIds() {
    const ids = new Set();
    for (const entry of this.ctx.loader?.entries() ?? []) {
      if (typeof entry.options?.id !== 'string') continue;
      if (entry.disabled) ids.add(entry.options.id);
    }
    return ids;
  }

  /**
   * Read the profile manifest's ordered bundle selection.
   *
   * Read directly rather than through app-boot: this is the same file the
   * plugin manager writes and the only fact needed is which bundles are
   * selected, so no composition machinery has to be duplicated.
   * @returns Selected bundle names, or an empty list when unknown.
   */
  readSelectedBundles() {
    const profile = this.ctx.get?.('profileContext');
    if (!profile?.dir) return [];
    try {
      const manifest = JSON.parse(readFileSync(join(profile.dir, 'package.json'), 'utf8'));
      const bundles = manifest?.dsh?.profile?.bundles;
      return Array.isArray(bundles) ? bundles.filter((name) => typeof name === 'string') : [];
    } catch (error) {
      this.#warn(`could not read the profile manifest: ${message(error)}`);
      return [];
    }
  }

  /**
   * Compare the current bundle selection with the last observation.
   * @returns Bundle names added and removed since the previous call.
   */
  syncBundleSelection() {
    const current = new Set(this.readSelectedBundles());
    const added = [...current].filter((name) => !this.#knownBundles.has(name));
    const removed = [...this.#knownBundles].filter((name) => !current.has(name));
    this.#knownBundles = current;
    return { added, removed };
  }

  /**
   * Bundles a manager operation may have left unmounted.
   *
   * Only bundles this process did not start with are candidates: a shipped
   * bundle legitimately keeps rows switched off, and re-driving one of those
   * would report a failure that is not one.
   * @returns Bundle names worth verifying.
   */
  async autoRepairCandidates() {
    const { added } = this.syncBundleSelection();
    const candidates = new Set(added.filter((name) => !this.#startedBundles.has(name)));
    let bundles;
    try {
      bundles = await this.listBundles();
    } catch (error) {
      this.#warn(`could not read the bundle table: ${message(error)}`);
      return [...candidates];
    }
    for (const bundle of bundles ?? []) {
      if (this.#startedBundles.has(bundle.name)) continue;
      if (this.needsRepair(bundle)) candidates.add(bundle.name);
    }
    return [...candidates];
  }

  /**
   * Verify and, when needed, repair one bundle through the plugin manager.
   * @param name - Bundle package name.
   * @returns Outcome record.
   */
  async repairBundle(name) {
    const manager = this.ctx.get?.('pluginManager');
    if (!manager || typeof manager.setBundleEnabled !== 'function') {
      return { bundle: name, status: 'unsupported' };
    }
    let bundle;
    try {
      bundle = (await manager.listBundles())?.find((item) => item.name === name);
    } catch (error) {
      return { bundle: name, status: 'failed', error: message(error) };
    }
    if (bundle === undefined) return { bundle: name, status: 'unknown-bundle' };
    if (bundle.enabled !== true) return { bundle: name, status: 'not-selected' };
    if (!this.needsRepair(bundle)) return { bundle: name, status: 'healthy' };
    // Repairing a bundle makes the manager emit `plugin-manager/changed`, which
    // would schedule the next pass. An unactivatable bundle (an incompatible
    // version, a missing peer) would then repair itself forever; one attempt per
    // cooldown keeps the loop bounded and the outcome recorded.
    const last = this.#repairAttempts.get(name);
    const now = Date.now();
    const cooldown = Number(this.config.repairCooldownMs) > 0 ? Number(this.config.repairCooldownMs) : REPAIR_COOLDOWN_MS;
    if (last !== undefined && now - last < cooldown) {
      return { bundle: name, status: 'cooling-down', retryInMs: cooldown - (now - last) };
    }
    this.#repairAttempts.set(name, now);
    this.#repairing = true;
    try {
      return await this.#repair(name, bundle);
    } finally {
      this.#repairing = false;
    }
  }

  /**
   * The repair itself, with the re-entry guard already taken.
   * @param name - Bundle package name.
   * @param bundle - Its record from `pluginManager.listBundles()`.
   * @returns Outcome record.
   */
  async #repair(name, bundle) {
    const manager = this.ctx.get?.('pluginManager');
    const probe = await this.#probeImport(bundle);
    const record = {
      bundle: name,
      ...purged > 0 ? { purgedModules: purged } : {},
      ...modules.length > 0 ? { modules } : {},
      ...probe === undefined ? {} : { probe },
    };

    let managerStatus;
    try {
      const change = await manager.setBundleEnabled(name, true);
      managerStatus = change?.application;
      const failure = change?.error;
      if (failure !== undefined) record.error = failure.diagnostic ?? failure.code ?? 'failed';
      if (Array.isArray(change?.warnings) && change.warnings.length > 0) record.warnings = change.warnings;
    } catch (error) {
      record.error = message(error);
    }

    // The manager's verdict describes its own recomposition; what matters is
    // whether a row is running now. A row whose module specifier this runtime
    // cannot resolve is activated through its resolved URL instead.
    const rebound = await this.#rebindInactiveRows(bundle);
    if (rebound.length > 0) {
      record.rebound = rebound;
      delete record.error;
    }
    const live = this.activeRowIds();
    const active = (bundle.rows ?? []).filter((row) => live.has(row.rowId));
    record.status = active.length > 0 ? 'applied' : (managerStatus ?? 'failed');
    return record;
  }

  /**
   * Activate a bundle's inactive rows through their resolved module URLs.
   *
   * A plugin installed from a local directory is a `link:` dependency: its real
   * location stays outside the profile, while this runtime resolves module
   * specifiers for profile plugins through the composition it booted with,
   * which cannot name a package that lives outside the profile. The already
   * resolved file URL imports fine, and binding it once is enough: a later
   * recomposition restores the row's declared specifier without touching the
   * live fiber, so the plugin keeps running either way.
   * @param bundle - One bundle record from `pluginManager.listBundles()`.
   * @returns Row ids that were activated this way.
   */
  async #rebindInactiveRows(bundle) {
    const loader = this.ctx.loader;
    const profile = this.ctx.get?.('profileContext');
    if (!loader || !profile?.dir) return [];
    const parentURL = pathToFileURL(join(profile.dir, 'cordis.yml')).href;
    const entries = [...loader.entries()];
    const rebound = [];
    for (const row of bundle.rows ?? []) {
      if (this.activeRowIds().has(row.rowId)) continue;
      const entry = entries.find((item) => item.options?.id === row.rowId);
      if (entry === undefined || entry.disabled) continue;
      const url = await resolveModuleUrl(loader, row.moduleName, parentURL);
      if (url === undefined) continue;
      if (await this.#rebindEntry(entry, url)) rebound.push(row.rowId);
    }
    return rebound;
  }

  /**
   * Bind one inactive entry to a resolved module URL and start it.
   * @param entry - Inactive Loader entry.
   * @param url - Resolved module URL of the same row.
   * @returns Whether the entry now has a running fiber.
   */
  async #rebindEntry(entry, url) {
    const declared = entry.options.name;
    if (typeof declared !== 'string' || declared === '' || declared.startsWith('file:')) return false;
    try {
      await entry.update({ name: url });
    } catch (error) {
      this.#warn(`could not bind ${declared} to ${url}: ${message(error)}`);
    }
    if (entry.fiber?.uid) {
      // Put the composed specifier back before anything can persist the tree:
      // `entry.options` is the element of the enclosing group's data, so a
      // Loader write between here and the next recomposition would save the
      // resolved URL into the profile. A name-only change never remounts.
      entry.options.name = declared;
      this.#info(`bound ${declared} to ${url} to start it`);
      return true;
    }
    try {
      await entry.update({ name: declared });
    } catch {
      /* the next recomposition restores the declared specifier regardless */
    }
    return false;
  }

  /**
   * Import a bundle's declared module once to capture the real failure reason.
   *
   * The manager reports only "failed to import"; the Loader logs the cause and
   * carries on, which leaves an operator guessing. Importing the module here
   * surfaces the message that actually matters (a missing dependency, a syntax
   * error, an unresolvable specifier), and doubles as a warm-up: a module that
   * imports cleanly is left in the loader's cache for the retry that follows.
   * @param bundle - One bundle record from `pluginManager.listBundles()`.
   * @returns The first row's import outcome, or undefined when nothing is declared.
   */
  async #probeImport(bundle) {
    const loader = this.ctx.loader;
    const profile = this.ctx.get?.('profileContext');
    if (!loader || typeof loader.import !== 'function' || !profile?.dir) return undefined;
    const parentURL = pathToFileURL(join(profile.dir, 'cordis.yml')).href;
    for (const row of bundle.rows ?? []) {
      const url = await resolveModuleUrl(loader, row.moduleName, parentURL);
      if (url === undefined) return { row: row.rowId, module: row.moduleName, ok: false, error: 'module specifier does not resolve' };
      try {
        await loader.import(url, () => []);
        return { row: row.rowId, module: row.moduleName, url, ok: true };
      } catch (error) {
        return { row: row.rowId, module: row.moduleName, url, ok: false, error: message(error) };
      }
    }
    return undefined;
  }

  /**
   * Drop module jobs a bundle left behind in its failed state.
   *
   * A first import that failed — a missing dependency, a syntax error that has
   * since been fixed — leaves its module job in the running Node loader, and
   * every later attempt to import the same URL keeps rejecting until that job
   * is gone. Re-driving the composition alone would therefore retry a poisoned
   * URL forever, which is exactly the "takes effect at the next start" state.
   *
   * This runs only for a bundle that has no running row, so any cached job for
   * its declared modules is by definition one that never produced a plugin.
   * @param bundle - One bundle record from `pluginManager.listBundles()`.
   * @returns How many module URLs were dropped, plus a per-row diagnostic.
   */
  async #purgeCachedModules(bundle) {
    const loader = this.ctx.loader;
    const profile = this.ctx.get?.('profileContext');
    const cache = loadCacheOf(this.ctx);
    if (!loader || !profile?.dir || !cache) return { purged: 0, modules: [] };
    const parentURL = pathToFileURL(join(profile.dir, 'cordis.yml')).href;
    const modules = [];
    const stale = [];
    for (const row of bundle.rows ?? []) {
      const url = await resolveModuleUrl(loader, row.moduleName, parentURL);
      const cached = url !== undefined && jobOf(cache, url) !== undefined;
      modules.push({ row: row.rowId, module: row.moduleName, url, cached });
      if (cached) stale.push(url);
    }
    if (stale.length === 0) return { purged: 0, modules };
    const { purged } = purgeModuleCache(this.ctx, stale);
    if (purged > 0) this.#info(`purged ${purged} cached module job(s) for ${bundle.name}`);
    return { purged, modules };
  }

  /**
   * Deep-reload the plugins that own a set of files or directories.
   * @param paths - Absolute paths; a directory matches every live plugin inside it.
   * @returns A pass result limited to the forced reload.
   */
  async reloadPaths(paths) {
    return await this.run('reload', { paths });
  }

  /**
   * The status document served by the HTTP route and used by tests.
   * @param detail - Include the per-entry module snapshot.
   * @returns JSON-safe status.
   */
  status(detail = false) {
    return {
      plugin: 'dsh_plugin_refresh',
      version: '0.1.0',
      generation: this.generation,
      startedAt: this.startedAt,
      config: {
        autoCheck: this.config.autoCheck,
        autoRepair: this.config.autoRepair,
        deepReload: this.config.deepReload,
        watchProfile: this.config.watchProfile,
        devWatch: this.config.devWatch,
        route: this.config.route,
      },
      watchedEntries: this.#snapshot.size,
      watchedFiles: [...this.#snapshot.values()].reduce((total, entry) => total + entry.files.length, 0),
      disposed: this.#disposed,
      pendingTimers: this.#timers.size,
      pollIntervalMs: this.config.pollIntervalMs,
      polls: this.#polls,
      watching: this.#watched,
      lastResult: this.#lastResult,
      history: this.#history,
      ...detail ? {
        entries: [...this.#snapshot.values()].map((entry) => ({
          name: entry.name,
          url: entry.url,
          files: entry.files.map((file) => ({ path: file.path, mtimeMs: file.mtimeMs, size: file.size })),
        })),
      } : {},
    };
  }

  /**
   * One full pass.
   * @param reason - Label recorded in the result.
   * @param options - `bundle` and `paths` narrow the pass.
   * @returns Pass result.
   */
  async #execute(reason, options) {
    if (this.#disposed) return undefined;
    const result = {
      reason,
      startedAt: Date.now(),
      durationMs: 0,
      bundle: options.bundle,
      reloadedModules: [],
      purgedModules: 0,
      staleDetected: 0,
      repairs: [],
      health: [],
      notes: [],
      error: undefined,
    };
    let moved = false;
    if (options.light) this.#polls += 1;
    try {
      const forced = resolveForcedUrls(await this.#snapshotUrls(), options.paths);
      const stale = forced.length > 0 ? forced : this.staleUrls();
      result.staleDetected = stale.length;
      if (this.config.deepReload && stale.length > 0) {
        // Module replacement touches live fibers, so it belongs in the
        // hot-reload queue. Nothing inside this block may call back into a
        // service that takes that queue itself.
        await this.#exclusive(async () => {
          const report = await deepReloadModules(this.ctx, stale, { warn: (text) => this.#warn(text) });
          result.reloadedModules = report.reloaded;
          result.purgedModules = report.purged;
          result.notes.push(...report.skipped);
          if (report.error) result.notes.push(report.error);
        });
      }

      if (!options.light && this.config.autoRepair) {
        // Repairs go through the plugin manager, which takes the profile writer
        // lock *and* the hot-reload queue itself; calling it from inside our own
        // queue would be rejected as a nested transaction.
        if (options.bundle) result.repairs.push(await this.repairBundle(options.bundle));
        if (options.manage) {
          for (const name of await this.autoRepairCandidates()) {
            if (options.bundle === name) continue;
            result.repairs.push(await this.repairBundle(name));
          }
        }
      }

      // Re-baseline only after a pass that actually changed something, or when
      // the tree itself moved. A pass that found nothing, or that failed to act,
      // must not absorb an edit the next pass should still see.
      const acted = result.repairs.some((repair) => repair.status !== 'healthy' && repair.status !== 'cooling-down');
      moved = result.reloadedModules.length > 0 || acted || options.resnapshot === true;
      if (moved) await this.captureSnapshot();
      if (!options.light) result.health = await this.#health();
    } catch (error) {
      result.error = message(error);
      this.#warn(`pass "${reason}" failed: ${result.error}`);
    }
    result.durationMs = Date.now() - result.startedAt;
    // A quiet poll is not an event worth remembering; recording one per tick
    // would push the passes an operator cares about out of the history.
    if (!options.light || moved || result.staleDetected > 0 || result.notes.length > 0 || result.error !== undefined) {
      this.#lastResult = result;
      this.#history.unshift(result);
      if (this.#history.length > HISTORY_LIMIT) this.#history.length = HISTORY_LIMIT;
      this.#report(result);
    }
    return result;
  }

  /**
   * Module URLs of the current snapshot, for `paths`-forced reloads.
   * @returns Snapshot URLs.
   */
  async #snapshotUrls() {
    if (this.#snapshot.size === 0) await this.captureSnapshot();
    return [...this.#snapshot.values()].map((item) => item.url);
  }

  /**
   * Run `operation` inside the hot-reload queue when that service exists.
   * @param operation - Work that must not overlap a module or config replacement.
   * @returns The operation result.
   */
  async #exclusive(operation) {
    const hmr = this.ctx.get?.('hmr');
    if (!hmr || typeof hmr.runExclusive !== 'function') return await operation();
    try {
      return await hmr.runExclusive(operation);
    } catch (error) {
      // The hot-reload service rejects a transaction opened inside another one.
      // That happens when this pass was scheduled from inside the queue — most
      // often its own mount, which the manager performs inside `runExclusive`.
      // The queue is already held at that point, so running inline is ordered.
      if (/cannot be nested/i.test(message(error))) return await operation();
      throw error;
    }
  }

  /**
   * Bundle health table for the status route.
   * @returns One record per bundle.
   */
  async #health() {
    let bundles;
    try {
      bundles = await this.listBundles();
    } catch (error) {
      this.#warn(`could not read the bundle table: ${message(error)}`);
      return [];
    }
    if (bundles === undefined) return [];
    const live = this.activeRowIds();
    return bundles.map((bundle) => {
      const rows = Array.isArray(bundle.rows) ? bundle.rows : [];
      const active = rows.filter((row) => live.has(row.rowId)).length;
      return {
        name: bundle.name,
        version: bundle.version,
        enabled: bundle.enabled === true,
        installed: bundle.installed === true,
        rows: rows.length,
        activeRows: active,
        needsRepair: this.needsRepair(bundle),
        error: bundle.error === undefined ? undefined : (bundle.error.code ?? 'error'),
      };
    });
  }

  /** Install file watches for the profile layer and every `devWatch` path. */
  #installWatches() {
    /** @type {Array<{ target: string, profile: boolean }>} */
    const targets = [];
    if (this.config.watchProfile) {
      const profile = this.ctx.get?.('profileContext');
      if (profile?.patchPath) targets.push({ target: profile.patchPath, profile: true });
      if (profile?.dir) targets.push({ target: join(profile.dir, 'package.json'), profile: true });
      if (profile?.home) targets.push({ target: join(profile.home, 'cordis.patch.yml'), profile: true });
    }
    for (const path of this.config.devWatch) targets.push({ target: path, profile: false });
    for (const { target, profile } of targets) this.#watchTarget(target, profile);
    this.#installPoll();
  }

  /**
   * Start the fingerprint poll that backs up file watching.
   *
   * OS file watching is not reliable everywhere — inside a packaged host on
   * Windows, `fs.watch` on the profile directory and on a development directory
   * can register successfully and then never deliver an event. A pass that only
   * compares recorded size and modification time costs one `stat` per watched
   * file and finds the same changes, so this runs regardless of whether the
   * watchers fire. Set `pollIntervalMs: 0` to turn it off.
   */
  #installPoll() {
    const interval = Number(this.config.pollIntervalMs);
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.#pollTimer = setInterval(() => {
      this.run('poll', { light: true }).catch(() => undefined);
    }, Math.max(250, interval));
    if (typeof this.#pollTimer.unref === 'function') this.#pollTimer.unref();
  }

  /**
   * Watch one file or directory.
   *
   * A profile layer is watched through a non-recursive watch of its parent
   * directory and matched by name: the profile directory also holds
   * `node_modules` and the manager's logs, and a recursive watch there would
   * turn unrelated writes into composition passes. A `devWatch` entry is a
   * directory the operator named, so it is watched recursively.
   * @param target - Absolute path; a missing file is watched through its parent.
   * @param profile - Whether a change concerns the profile composition.
   */
  #watchTarget(target, profile) {
    const isFile = /\.(json|yml|yaml)$/i.test(target);
    const directory = isFile ? dirname(target) : target;
    const filename = isFile ? basename(target).toLowerCase() : undefined;
    const options = isFile ? {} : { recursive: true };
    const registration = { target, directory, recursive: !isFile, changes: 0 };
    const onChange = (eventType, changed) => {
      registration.changes += 1;
      if (this.#disposed) return;
      if (filename !== undefined && typeof changed === 'string' && changed.toLowerCase() !== filename) return;
      if (profile) this.schedule('profile-change', this.config.debounceMs);
      else if (this.config.devReload) this.schedule('dev-change', this.config.debounceMs);
    };
    try {
      const watcher = watch(directory, options, onChange);
      watcher.on('error', (error) => this.#warn(`watch ${directory} failed: ${message(error)}`));
      this.#watchers.push(watcher);
      this.#watched.push(registration);
    } catch (error) {
      this.#warn(`cannot watch ${directory}: ${message(error)}`);
    }
  }

  /**
   * Log one pass at a level matching what it found.
   * @param result - Completed pass result.
   */
  #report(result) {
    const actions = [];
    if (result.reloadedModules.length > 0) actions.push(`${result.reloadedModules.length} module(s) reloaded`);
    for (const repair of result.repairs) {
      const purged = repair.purgedModules === undefined ? '' : `, ${repair.purgedModules} failed module job(s) purged`;
      actions.push(`bundle ${repair.bundle}: ${repair.status}${purged}${repair.error === undefined ? '' : ` (${repair.error})`}`);
    }
    if (result.error) actions.push(`error: ${result.error}`);
    for (const bundle of result.health) {
      if (bundle.enabled !== true) continue;
      if (bundle.error !== undefined) {
        actions.push(`broken: ${bundle.name} (${bundle.error})`);
        continue;
      }
      // A shipped bundle may leave rows switched off on purpose; only a
      // third-party bundle with no running row is worth a line.
      if (bundle.needsRepair === true && !this.#startedBundles.has(bundle.name)) {
        actions.push(`inactive: ${bundle.name} (${bundle.activeRows}/${bundle.rows} rows)`);
      }
    }
    if (actions.length === 0) {
      if (this.config.verbose) this.#info(`pass "${result.reason}" found nothing to do`);
      return;
    }
    this.#info(`pass "${result.reason}": ${actions.join('; ')}`);
  }

  /**
   * Log a line through the owning context's logger.
   * @param level - Logger method name.
   * @param text - Message text.
   */
  #say(level, text) {
    const logger = this.ctx.logger?.[level] ?? this.ctx.logger?.info;
    if (typeof logger !== 'function') return;
    logger.call(this.ctx.logger, `[plugin-refresh] ${String(text).replace(/%/g, '%%')}`);
  }

  #info(text) {
    this.#say('info', text);
  }

  #warn(text) {
    this.#say('warn', text);
  }
}

/**
 * Render an unknown thrown value as a message.
 * @param error - Thrown value.
 * @returns Message text.
 */
function message(error) {
  if (error === null || error === undefined) return 'unknown error';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map forced filesystem paths onto the module URLs that own them.
 * @param urls - Every live module URL.
 * @param paths - Forced absolute paths, if any.
 * @returns Matching module URLs; empty when nothing was forced.
 */
function resolveForcedUrls(urls, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const wanted = paths.map((path) => normalize(path));
  const matched = [];
  for (const url of urls) {
    const info = moduleFileInfo(url);
    if (!info) continue;
    const file = normalize(info.path);
    // A named path either *is* the module file or is a directory above it;
    // matching on a string prefix alone would let a file name swallow siblings.
    if (wanted.some((path) => file === path || file.startsWith(`${path}/`))) matched.push(url);
  }
  return matched;
}
