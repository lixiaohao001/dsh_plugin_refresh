/**
 * HTTP surface for the refresh engine.
 *
 * The route is registered through the Web server's named-route contract: one
 * `prefix` route under the configured prefix, which wins over the SPA fallback
 * by being a longer match. It exposes the engine's own state only — plugin
 * names, paths and outcomes.
 *
 * The Web server enforces no origin or authentication policy of its own; that
 * belongs to the route owner. Every mutating method therefore requires a
 * same-origin request, which a browser cannot forge. GET is read-only.
 *
 * Registered routes:
 *
 * | Method | Path | Meaning |
 * |---|---|---|
 * | GET | `<prefix>/status` | Config, snapshot size, last pass, bundle health. |
 * | GET | `<prefix>/status?detail=1` | Adds the per-entry module snapshot. |
 * | POST | `<prefix>/check` | Run one pass now (deep reload + health scan). |
 * | POST | `<prefix>/repair?bundle=<name>` | Verify and re-drive one bundle through the plugin manager. |
 * | POST | `<prefix>/reload?path=<abs>` | Deep-reload the plugins that own a file or directory. |
 *
 * @module dsh_plugin_refresh/routes
 */

/** Largest JSON body this route answers with. */
const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * Register the status route when a Web server is composed.
 * @param ctx - The plugin's context.
 * @param engine - The refresh engine.
 * @param config - Resolved config.
 * @returns A disposer removing the route registration.
 */
export function registerRoutes(ctx, engine, config) {
  const prefix = typeof config.route === 'string' ? config.route.replace(/\/+$/, '') : '';
  if (prefix === '') return () => undefined;
  const dispose = ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.get('webServer');
    if (!server || typeof server.register !== 'function') return;
    webCtx.effect(
      () => server.register({
        kind: 'prefix',
        path: prefix,
        handler: (req, res) => {
          handle(req, res, engine, prefix).catch((error) => {
            send(res, 500, { ok: false, error: error?.message ?? String(error) });
          });
        },
      }),
      'plugin-refresh: status route',
    );
  });
  return typeof dispose === 'function' ? dispose : () => undefined;
}

/**
 * Reject a mutating request that a browser page issued from another origin.
 *
 * A same-origin request either omits `Origin` (every non-browser client) or
 * names the host it reached; a cross-site page cannot claim the second.
 * @param req - Node request.
 * @returns True when the request may mutate state.
 */
function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === req.headers?.host;
  } catch {
    return false;
  }
}

/**
 * Answer one request.
 * @param req - Node request.
 * @param res - Node response.
 * @param engine - The refresh engine.
 * @param prefix - Registered route prefix.
 */
async function handle(req, res, engine, prefix) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '');
  const method = (req.method ?? 'GET').toUpperCase();
  const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : '';

  if (suffix === '/status') {
    if (method !== 'GET' && method !== 'HEAD') return void send(res, 405, { ok: false, error: 'method-not-allowed' });
    const detail = url.searchParams.get('detail') === '1';
    return void send(res, 200, { ok: true, status: engine.status(detail) });
  }

  if (method === 'POST' && !sameOrigin(req)) {
    return void send(res, 403, { ok: false, error: 'cross-origin' });
  }

  if (suffix === '/check') {
    if (method !== 'POST') return void send(res, 405, { ok: false, error: 'method-not-allowed' });
    const result = await engine.run('http-check');
    return void send(res, 200, { ok: true, result });
  }

  if (suffix === '/repair') {
    if (method !== 'POST') return void send(res, 405, { ok: false, error: 'method-not-allowed' });
    const bundle = url.searchParams.get('bundle');
    if (bundle === null || bundle === '') {
      const bundles = (await engine.listBundles()) ?? [];
      const repairs = [];
      for (const item of bundles) {
        if (engine.needsRepair(item)) repairs.push(await engine.repairBundle(item.name));
      }
      return void send(res, 200, { ok: true, repairs });
    }
    return void send(res, 200, { ok: true, repair: await engine.repairBundle(bundle) });
  }

  if (suffix === '/reload') {
    if (method !== 'POST') return void send(res, 405, { ok: false, error: 'method-not-allowed' });
    const path = url.searchParams.get('path');
    if (path === null || path === '') return void send(res, 400, { ok: false, error: 'path-required' });
    const result = await engine.reloadPaths([path]);
    return void send(res, 200, { ok: true, result });
  }

  return void send(res, 404, { ok: false, error: 'unknown-route', routes: ['/status', '/check', '/repair', '/reload'] });
}

/**
 * Send a JSON response. A second call for the same response is ignored, so a
 * throw after the first send cannot escape as an unhandled rejection.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param body - JSON-safe body.
 */
function send(res, status, body) {
  if (res.headersSent === true) {
    try {
      res.end();
    } catch {
      /* the socket is already gone */
    }
    return;
  }
  let text;
  try {
    text = JSON.stringify(body);
  } catch (error) {
    status = 500;
    text = JSON.stringify({ ok: false, error: `unserializable result: ${error?.message ?? String(error)}` });
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    status = 500;
    text = JSON.stringify({ ok: false, error: 'response-too-large' });
  }
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}
