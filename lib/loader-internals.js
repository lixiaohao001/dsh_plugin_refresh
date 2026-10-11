/**
 * Tolerant helpers over the running Node ESM loader, the CJS require cache, and
 * Cordis Loader entries.
 *
 * Everything here is deliberately defensive. These are process-internal
 * surfaces whose exact shape differs between Node 22/23 (`ModuleLoader` v1) and
 * Node 24+ (v2, where a load-cache value is a per-format record rather than a
 * `ModuleJob`). A shape this module cannot recognise degrades to "unknown" and
 * the caller reports it, instead of throwing into an event handler.
 *
 * @module dsh_plugin_refresh/loader-internals
 */
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Whether a value is a Node `ModuleJob`.
 * @param value - Candidate value from the load cache.
 * @returns True when the value exposes the module-job surface.
 */
function isModuleJob(value) {
  return value !== null && typeof value === 'object' && typeof value.url === 'string';
}

/**
 * Read the running Node ESM load cache.
 * @param ctx - Any context whose Loader owns the process loader.
 * @returns The load cache, or undefined when Node internals are unavailable.
 */
export function loadCacheOf(ctx) {
  const cache = ctx?.loader?.internal?.loadCache;
  return cache ?? undefined;
}

/**
 * Read one load-cache entry as a module job, tolerating both loader shapes.
 * @param cache - Load cache from {@link loadCacheOf}.
 * @param url - Module URL key.
 * @returns The module job, or undefined when the URL is not cached.
 */
export function jobOf(cache, url) {
  if (!cache || typeof url !== 'string') return undefined;
  let raw;
  try {
    raw = Map.prototype.get.call(cache, url);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw === null) return undefined;
  if (isModuleJob(raw)) return raw;
  if (typeof raw === 'object') {
    for (const value of Object.values(raw)) if (isModuleJob(value)) return value;
  }
  return undefined;
}

/**
 * List every URL currently held by the load cache.
 * @param cache - Load cache from {@link loadCacheOf}.
 * @returns Cached module URLs, or an empty list when unavailable.
 */
export function cacheUrls(cache) {
  if (!cache) return [];
  try {
    return [...Map.prototype.keys.call(cache)];
  } catch {
    try {
      return [...cache.keys()];
    } catch {
      return [];
    }
  }
}

/**
 * Remove one URL from the load cache.
 *
 * `Map.prototype.delete` is used deliberately: under Node 24 the cache's own
 * `delete` only clears the format slot and leaves the key behind, so a plain
 * call would not force a fresh import.
 * @param cache - Load cache from {@link loadCacheOf}.
 * @param url - Module URL key.
 * @returns The removed module job, or undefined when nothing was cached.
 */
export function dropCacheUrl(cache, url) {
  if (!cache) return undefined;
  const job = jobOf(cache, url);
  try {
    Map.prototype.delete.call(cache, url);
  } catch {
    try {
      cache.delete(url);
    } catch {
      return undefined;
    }
  }
  return job;
}

/**
 * Put a module job back into the load cache (rollback path).
 * @param cache - Load cache from {@link loadCacheOf}.
 * @param url - Module URL key.
 * @param job - Job returned by {@link dropCacheUrl}.
 */
export function restoreCacheUrl(cache, url, job) {
  if (!cache || job === undefined) return;
  try {
    Map.prototype.set.call(cache, url, job);
  } catch {
    /* a cache that rejects the original job is left as it is */
  }
}

/**
 * Drop a file URL from the CommonJS require cache.
 *
 * Node 24 keeps CJS modules loaded through `import()` in both caches; clearing
 * only the ESM one can still serve a stale module.
 * @param url - Module URL of a CJS module.
 * @returns A record for {@link restoreRequireCache}, or undefined when absent.
 */
export function dropRequireCache(url) {
  let file;
  try {
    file = fileURLToPath(url);
  } catch {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(require.cache, file)) return undefined;
  const previous = require.cache[file];
  Reflect.deleteProperty(require.cache, file);
  return { file, previous };
}

/**
 * Restore a record produced by {@link dropRequireCache}.
 * @param record - The record to restore.
 */
export function restoreRequireCache(record) {
  if (!record) return;
  require.cache[record.file] = record.previous;
}

/**
 * Resolve a Loader entry's module specifier to the URL Node would import.
 *
 * Mirrors the HMR service's own resolution so both agree on module identity.
 * @param loader - The Cordis Loader service.
 * @param specifier - Entry `name`.
 * @param parentURL - The owning tree's base URL.
 * @returns The resolved module URL, or undefined when it cannot be resolved.
 */
export async function resolveModuleUrl(loader, specifier, parentURL) {
  if (typeof specifier !== 'string' || specifier === '') return undefined;
  const internal = loader?.internal;
  if (specifier.startsWith('cordis:')) return undefined;
  try {
    if (!internal) {
      if (/^[a-zA-Z]+:/.test(specifier) || specifier.startsWith('.')) {
        return new URL(specifier, parentURL).href;
      }
      return require.resolve(specifier, { paths: [fileURLToPath(parentURL)] });
    }
    if (internal.version === 'v2') {
      return internal.resolveSync(parentURL, { specifier, attributes: {} }).url;
    }
    if (typeof internal.resolve === 'function') {
      return (await internal.resolve(specifier, parentURL, {})).url;
    }
    if (typeof internal.resolveSync === 'function') {
      return internal.resolveSync(specifier, parentURL, {}).url;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Stat the file behind a module URL.
 * @param url - Module URL.
 * @returns Path, size, and modification time, or undefined for non-file URLs and missing files.
 */
export function moduleFileInfo(url) {
  let path;
  try {
    path = fileURLToPath(url);
  } catch {
    return undefined;
  }
  try {
    const info = statSync(path);
    if (!info.isFile()) return undefined;
    return { path, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Find the package root (the directory holding `package.json`) above a module URL.
 *
 * The walk stops before a `node_modules` boundary so a shared store path can
 * never cause a sibling package to be purged with this one.
 * @param url - Module URL of a file inside the package.
 * @returns Directory path of the package root, or the file's own directory.
 */
export function packageRootOf(url) {
  let path;
  try {
    path = fileURLToPath(url);
  } catch {
    return undefined;
  }
  let current = dirname(path);
  const stoppedAt = current;
  for (let depth = 0; depth < 24; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    if (parent.endsWith('node_modules')) break;
    current = parent;
  }
  return stoppedAt;
}

/**
 * Find the load-cache URL that holds a given module file.
 *
 * A row's declared specifier and the URL actually imported can differ in
 * spelling while pointing at the same file: a cache-busting query string, a
 * Windows short-name realpath, a symlink followed during resolution. Matching
 * on the resolved file path keeps the plugin's module identity stable across
 * those spellings, so its dependency graph and its cached generation remain
 * findable from the declared specifier alone.
 * @param cache - Load cache from {@link loadCacheOf}.
 * @param url - Module URL to look up.
 * @returns The cached URL for the same file, or undefined when nothing matches.
 */
export function cachedUrlFor(cache, url) {
  if (!cache || typeof url !== 'string' || url === '') return undefined;
  if (jobOf(cache, url) !== undefined) return url;
  const info = moduleFileInfo(url);
  if (!info) return undefined;
  for (const candidate of cacheUrls(cache)) {
    if (candidate === url) continue;
    const other = moduleFileInfo(candidate);
    if (other !== undefined && other.path === info.path) return candidate;
  }
  return undefined;
}

/**
 * Whether a module URL points at a file inside a directory.
 * @param url - Module URL.
 * @param directory - Absolute directory path.
 * @returns True when the file lives under the directory.
 */
export function isInsideDirectory(url, directory) {
  if (!directory) return false;
  const info = moduleFileInfo(url);
  if (!info) return false;
  const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = normalize(info.path);
  const root = normalize(directory);
  return file === root || file.startsWith(`${root}/`);
}
