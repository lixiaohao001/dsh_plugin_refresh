# `dsh_plugin_refresh` — DSH 0.2.0-rc.2 plugin authoring spec

> **Not official documentation.** This is a record of behaviour observed in a local DSH
> `0.2.0-rc.2` installation, written while building this plugin. The packages it cites ship inside
> the Electron bundle at `<dsh-install>/resources/app.asar`; any asar reader can extract them.
> Line numbers move between releases, so read every `path:line` as "where to look", not as a
> stable address. Where official package READMEs state a contract, prefer them over this file.

`R` = the extracted `dsh/node_modules/@deepseek-ai` directory. All `path:line` are relative to `R` unless absolute. Verified against the live `desktop` profile plugins.

## 1. `package.json` contract

```json
{
  "name": "dsh_plugin_refresh",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.4" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `name` **mandatory**, and it must equal the `name` the patch inserts; bundle dirs resolve by package name (`dsh-app-boot/lib/index.js:882-899`). Real plugin: `@nanmicoder/dsh-agent-teams/cordis.patch.yml:15` = its `package.json:2`.
- `version` **mandatory**; `name@version` is the exemption key (`:303-306`).
- `type`/`main`/`exports["."]` — the Loader imports the bare specifier through Node ESM, so one of them must reach `lib/index.js`. All four real plugins use `"type":"module"` + `"main":"lib/index.js"` + an explicit `exports["."]`.
- `exports["./client"]` — **only for the client half** (§5); string or `{default:string}` (`dsh-client-modules/lib/index.js:171-181`). A package declaring `dsh.client` without it **throws** (`:719`).
- `exports["./package.json"]` — **required for display metadata**: `readPluginMeta` resolves `` `${specifier}/package.json` `` through Node exports (`dsh-app-boot/lib/index.js:1974`). `exports["./cordis.patch.yml"]` is convention only — `dsh.bundle.patch` is a literal package-relative file (`:495-508`) and bundle resolution never needs the subpath (`:874-899`).
- `engines.node` — informational; no DSH code reads `engines` (0 grep hits in `dsh-app-boot/lib/index.js`). **`engines.dsh` is ignored by DSH**: "These checks use peer declarations, not `engines.dsh`" (`dsh-app-boot/README.md:52`; code `:286-301`). Only `dsh-workbuddy-bridge/package.json:19` sets it; the rest omit it. Declare `peerDependencies["@deepseek-ai/dsh"]` instead — that is what gates loading.
- `dsh.bundle.patch` **mandatory to be a profile layer**; string or ordered list (`:496-497`). Without it pnpm installs a plain dependency: `declares no dsh.bundle — installed as a plain dependency, not a profile layer` (`dsh-plugin-manager/lib/types/operations.js:57-60`).
- `dsh.client` — omit for host-only; if present, `platform` must be a string (`dsh-client-modules/lib/index.js:65`).
- `icon` optional: manifest-relative SVG/PNG/JPEG/WebP ≤256 KiB inside the dir; failure keeps the text (`dsh-app-boot/lib/index.js:1957-1959`). Optional localized text: `locale/en.json` → `{"meta":{"title":…,"description":…}}` (`dsh-workbuddy-bridge/locale/en.json:1-6`). `files` matters only for npm packing.

## 2. `cordis.patch.yml` contract

Top-level YAML **array of patch mappings** (`dsh-app-boot/lib/index.js:3566-3568`), parsed by a JSON schema extended with the `!!js` tag → `{__jsExpr}` (`:20-33`):
```yaml
- insert:                              # appends rows; with `id:` appends into that group
    - id: refresh                      # tree key; required for later targeting
      name: dsh_plugin_refresh         # module specifier; must match the package name
      config: { intervalMs: 5000 }     # optional, validated against the plugin Config
      disabled: false                  # optional; !!js allowed (:89-93)
- id: refresh                          # non-insert patch: field overrides on an existing row
  config: { intervalMs: 1000 }         # REPLACES the whole config, never deep-merged
```

`id` is required for non-insert patches (`:91-94`); a truthy `name` **asserts** the row's existing name and a mismatch warns+skips (`:100-103`); an absent target warns+skips, not fatal (`:95-99`); `disabled` is truthy-coerced (`:89-93`); `!!js` is allowed and evaluated with `ctx` in scope (`cordis-plugin-loader/src/config/utils.ts:5-9`). Empty/comments-only overlay fails parsing (`:3566`); disable a layer with `[]` (`dsh-app-boot/README.md:61`).

Precedence, last wins per row: bundle patches in `dsh.profile.bundles` order → `<profile>/cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays (`dsh-app-boot/lib/index.js:1025-1030`; `dsh/README.md:41-44`).

## 3. Host module export contract

```js
import Schema from '@deepseek-ai/schemastery'
export const name = 'refresh'                  // optional display name
export const inject = ['webServer']            // optional required services
export const Config = Schema.object({ intervalMs: Schema.number().default(5000) })
export function apply(ctx, config) { /* ... */ }
```

The Loader takes `exports.default ?? exports` (`cordis-plugin-loader/src/index.ts:201-208`) and registers that namespace as the plugin. `RegistryService.resolve` accepts a function or an object with `.apply`, else throws `invalid plugin, expect function or object with an "apply" method` (`cordis/src/registry.ts:8-10,222-228,319`); `runtime.name` comes from `plugin.name` with the literal `'apply'` discarded (`:324-326`); `inject` is normalized by `Inject.resolve` (`:330`, `:71-88`); `Config` is applied per fiber (`:104,144`). Named exports and `export default apply` are therefore mutually exclusive — `default` wins and the metadata is lost. `reusable` is **not** part of this runtime's plugin contract (`[unconfirmed]`/absent).

`id` is independent of the package name: it is only the tree key (`cordis-plugin-loader/src/config/entry.ts:65-71`), while `name` resolves through the owning tree's `baseUrl` (`:224`; `tree.ts:112-128`). Both conventions ship: workbuddy's `name` equals its row id (`dsh-workbuddy-bridge/lib/index.js:1417`), skills-hub's does not.

## 4. Lifecycle inside `apply`

```js
export function apply(ctx, config) {
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.get('webServer')
    webCtx.effect(() => {
      const dispose = server.register({ kind: 'exact', path: '/api/refresh', handler })
      return () => dispose()
    }, 'dsh_plugin_refresh: route')
  })
  const off = ctx.on('some/event', handler)          // returns a disposable
  ctx.effect(() => () => clearInterval(timer), 'dsh_plugin_refresh: poll')
}
```

`ctx.inject(deps, cb)` is shorthand for `ctx.plugin({inject, apply: cb})` and unloads/re-runs on dependency change (`cordis/src/registry.ts:164-186,300-302`). `ctx.effect(body, label)` runs immediately, collects returned disposer(s), and runs them in reverse on the returned disposer or fiber unload; it throws `INACTIVE_EFFECT` on a disposed fiber (`cordis/src/fiber.ts:402-442`). `ctx.get(name)` is the lazy optional read. Real examples: `dsh-workbuddy-bridge/lib/index.js:1239-1248,1785-1787` (inject `["webServer"]`, then `ctx.effect` + `webServer.register` + dispose); `dsh-skills-hub/lib/index.js:31-40` (empty `inject` + lazy `ctx.get` of `webServer`/`httpServer`, so headless profiles stay inert).

## 5. Client half (brief)

Add `"exports": {"./client": "./lib/client.js"}` (§1) and `"dsh": {"bundle": {…}, "client": {"platform": "web", "external": ["react"]}}`. `platform` must be exactly `'web'` or the row is skipped (`dsh-client-modules/lib/index.js:65,714`); `inject` and `external` are both accepted string arrays (`:66-67`); `immediately` is boolean (`:68`). `./client` must be a lazy-CJS factory bundle that self-registers:

```js
window.__ModuleLoader__.load({ id: "dsh_plugin_refresh", factory: (require) => { /* module.exports = { apply, inject, name } */ } })
```

(`dsh-workbuddy-bridge/lib/client.js:1-3,1800-1806`). The host scans enabled Loader rows, composes `window.__DSH_BOOT__`, and serves `/plugins` (`dsh-client-modules/README.md:12,34,64`); the browser resolves against the frozen `PLATFORM_MODULES` seed and materializes lazily (`:44-46,68`). The built `lib/client.js` must exist first (`:50`), registered under the **package name** (`@nanmicoder/dsh-skills-hub/docs/CONTRACT.md:9`).

## 6. Local development / install loop

Installing a local directory: `dsh plugin --profile desktop add "C:\path\to\dsh_plugin_refresh"`. `dsh plugin --profile <name> <pnpm args>` forwards to pnpm in the profile dir (`dsh/README.md:18`). **Only an absolute path** is a valid local spec — relative paths are rejected (`dsh-plugin-manager/lib/types/install-spec.js:61-68`); `file:`/`link:` prefixes accepted; `installBundle` takes the same spec. After pnpm succeeds, reconciliation **appends** the name to `dsh.profile.bundles` (`operations.js:54-71`) — the highest-precedence bundle layer. `desktop` is reserved: the npm CLI rejects plugin management for it; the Desktop-installed CLI sets `manageDesktopProfile: true` (`dsh-desktop-host/lib/cli.js:91-105`).

Reload — **config live, code not**:

- Live: edits to `<profile>/cordis.patch.yml`, `$DSH_HOME/cordis.patch.yml`, and the `dsh.profile.bundles` list are re-read and reapplied (`dsh-hmr/README.md:27-47,57`; `dsh/README.md:37`) — enough to mount the new row without a restart.
- Not live by default: plugin **code**. Base mounts `hmr` with `config.root: []` — "Module roots are opt-in" (`dsh-base/cordis.patch.yml:27-32`) — the desktop profile does not override that row (`C:\Users\life\.dsh\profiles\desktop\cordis.patch.yml`, no `id: hmr`), and the default `ignored` is `["**/node_modules","**/.*","cache","data"]` (`dsh-hmr/README.md:47`). A changed file reloads only when its realpath is already in the Loader's module cache (`dsh-hmr/lib/index.js:382-412`), so changes under `node_modules` are ignored and a copied install needs reinstall/restart. Source watching requires `- id: hmr` / `disabled: false` / `config: {root: ["."]}` (`dsh-hmr/README.md:27-34`). `[unconfirmed]` whether pnpm's `hoisted` linker (desktop's `pnpm-workspace.yaml`) symlinks an absolute-path dependency — the shape that would make live code reload work.
- Client bundles have their own chain: HMR switches a changed row to a revisioned one-resource combo URL (`dsh-client-modules/README.md:38,74`).

