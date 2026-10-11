# dsh_plugin_refresh

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-4d7cfe.svg)](#compatibility)

**Install a DSH plugin and use it immediately — no restart.**

`dsh_plugin_refresh` is a DeepSeek Harness host plugin that watches the installed
composition and finishes plugin activation in the running process: it verifies the
bundles a plugin-manager operation could have left unmounted, re-drives them through
the same typed path the Web Plugins page uses, and reloads plugin code whose files
changed at an unchanged path. It never writes your profile manifest or patch layers.

> 中文说明见下方「中文文档」一节。本插件解决的是：**插件安装完成后无需重启 DSH 即可生效**。

---

## Why it exists

DeepSeek Harness already applies a *fresh* bundle install in-process when the profile is
live (the `hmr` service is composed): the plugin manager selects the bundle and calls
`reconcileProfilePatches`, and `app-boot/config-reload` follows. Three real cases still
end in "takes effect at the next start", and all three are covered here:

| Case | What happens without this plugin |
|---|---|
| The install named a dependency the profile already had (reinstall / upgrade / local re-link) | `installBundle` returns `application: "restart-required"` **before** reloading — the selection is saved, nothing mounts. |
| The first import of the plugin failed | Node caches the failed module job. Every later retry of the same module URL rejects with the same error, so the plugin stays dead until the process restarts — even after you fix the file. |
| The plugin's own files changed at the same path (rebuilt bundle, re-linked local dev plugin) | Installed packages live under `node_modules`, which the official hot-reload service ignores by design; the running process keeps the old code generation. |

## Prior art, and what is actually different here

Several DSH plugins already attack "no restart". Saying so plainly is part of shipping this one:

| Project | Approach | Overlap |
|---|---|---|
| [dsh-hot-reload](https://www.npmjs.com/package/dsh-hot-reload) | swaps an upgraded plugin in place, rolls back when the reload fails, otherwise asks for a manual restart | highest — the same in-place swap idea as `lib/deep-reload.js` |
| [dsh-hot-installer](https://www.npmjs.com/package/dsh-hot-installer) | hot install / remove / update / enable-disable of profile bundles; states that module-code changes still need a restart | high, on the host composition side |
| [dsh-hotreload-plugin-manager](https://github.com/kyorakuyk/dsh-hotreload-plugin-manager) | the same, plus a Web settings tab | high; adds a browser UI |
| [dsh-refresh](https://github.com/Woeful001/dsh-refresh) | a sidebar button that refreshes the inventory and reloads the page | complementary — it owns the browser half |
| [dsh-plugin-refresh](https://www.npmjs.com/package/dsh-plugin-refresh) | right-click → full page reload | same idea from the browser side; note the similar name |

What this package does that the others do not:

1. **It repairs a failed first import.** A plugin whose first import fails stays dead for the life of
   the process, because Node keeps the failed module job cached — fixing the file and retrying
   changes nothing. This pass drops the poisoned job and re-imports, which is why a broken install
   can still become usable without a restart.
2. **It surfaces the real error.** The plugin manager reports `failed to import` and nothing more;
   `repairs[].probe.error` carries the underlying exception, which is usually the whole answer.
3. **It is automatic and dependency-free.** Only `node:` builtins — no chokidar, no js-yaml, no build
   step (the file you edit is the file that runs). Detection is event-driven, with a fingerprint poll
   as a backstop, rather than a button someone has to press.
4. **It supports local `link:` installs**, whose real path sits outside the profile and whose bare
   specifier this runtime cannot resolve; the row is activated through its resolved URL instead.

Where it is weaker, plainly: no browser UI, no install/uninstall/update actions (it deliberately
performs no package operations), a small unit-test suite rather than an integration one, and it
reaches into Node loader internals, so it is sensitive to the DSH and Node version.

## What it does

One serialized pass, run on startup, after every `plugin-manager` operation, and when a
watched file changes:

1. **Deep reload** — every live plugin whose module files changed at an unchanged path is
   re-imported and re-activated in place, using the same steps as the official
   `@deepseek-ai/dsh-hmr` service: drop the Node ESM `loadCache` (with
   `Map.prototype.delete`, required on Node 24) and the CommonJS `require.cache` for the
   plugin's own package, re-import, `registry.delete()` the old generation, re-activate on
   the same fibers, and re-attach the original Loader `Entry` so entry identity, config and
   diagnostics survive the swap.
2. **Repair** — for a bundle that is selected but has no running row, it drops the poisoned
   module job, imports the declared module once to capture the *real* failure reason, then
   re-drives the composition through `pluginManager.setBundleEnabled()` — the official path,
   which takes the profile writer lock and the hot-reload queue itself. If the runtime still
   cannot resolve the row's declared specifier, the row is activated through its already
   resolved file URL (see *Local installs* below).
3. **Report** — a per-bundle health table (selected, running rows, error) and a bounded pass
   history, available in the log and over HTTP.

## Install

From this repository — no npm publish required:

```bash
dsh plugin --profile desktop add github:lixiaohao001/dsh_plugin_refresh
```

From a local clone, which is also the development setup (the package is linked, so edits are live):

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh_plugin_refresh
```

Or from an agent session, the `plugin_manager` tool action `install_bundle` with the same absolute
path. The package declares `dsh.bundle.patch`, so it installs as a profile bundle and inserts
exactly one row:

```yaml
- insert:
    - id: plugin-refresh
      name: dsh_plugin_refresh
```

## Configuration

Row config is validated by the exported schema when `@deepseek-ai/schemastery` is reachable,
and normalized by `lib/config.js` either way.

| Field | Default | Meaning |
|---|---|---|
| `autoCheck` | `true` | Check after startup and after every plugin-manager operation. |
| `autoRepair` | `true` | Re-drive a bundle that was just installed or enabled but has no running row. |
| `deepReload` | `true` | Reload plugin modules whose files changed at an unchanged path. |
| `watchProfile` | `true` | Watch the profile patch files and manifest. |
| `devWatch` | `[]` | Extra absolute files or directories to watch for plugin development. |
| `devReload` | `true` | Deep-reload when a `devWatch` path changes. |
| `pollIntervalMs` | `2000` | Interval of the fingerprint poll that backs up file watching; `0` disables it. A pass compares recorded size and modification time only, so it is cheap. |
| `debounceMs` | `400` | Quiet window that combines a burst of change events into one pass. |
| `startupDelayMs` | `1200` | Delay after application readiness before the first check. |
| `route` | `/api/plugin-refresh` | Status route prefix; an empty string disables the HTTP surface. |
| `verbose` | `false` | Log passes that found nothing to do. |

```yaml
- id: plugin-refresh
  config:
    devWatch:
      - /absolute/path/to/my-plugin/lib
```

## HTTP surface

Loopback-only, same as the Web server it registers on.

| Method | Path | Meaning |
|---|---|---|
| GET | `/api/plugin-refresh/status` | Config, engine generation, snapshot size, last pass, bundle health, pass history. |
| GET | `/api/plugin-refresh/status?detail=1` | Adds the per-entry module snapshot (file paths, recorded size and mtime). |
| POST | `/api/plugin-refresh/check` | Run one pass now. |
| POST | `/api/plugin-refresh/repair?bundle=<name>` | Verify and repair one bundle (all unhealthy bundles when `bundle` is omitted). |
| POST | `/api/plugin-refresh/reload?path=<abs>` | Deep-reload the plugins that own a file or directory. |

`generation` changes whenever the plugin replaces its own module generation, which makes a
successful hot reload directly observable: note it, save a source file, read it again.

Every POST requires a same-origin request. The Web server enforces no origin policy of its own
— that belongs to route owners — so a cross-site page could otherwise force reloads. A
same-origin request either omits `Origin` (all non-browser clients) or names the host it
reached, which a browser cannot forge.

## Developing a plugin with this installed

While `devWatch` covers your plugin's directory (or you call the reload route), editing a
source file is enough: the change is detected through each live entry's module graph, the
cached generations are dropped, and the plugin is swapped in place. Typical loop:

```powershell
# after editing <my-plugin>/lib/*.js
Invoke-WebRequest -Uri 'http://127.0.0.1:19387/api/plugin-refresh/reload?path=<my-plugin>/lib' -Method POST
```

### Local installs and the bare-specifier limit

A plugin installed from a local directory is a `link:` dependency whose real location stays
**outside** the profile. This runtime resolves module specifiers for profile plugins through
the composition it booted with, and a package that lives outside the profile cannot be named
by it: importing `<your-plugin>` by its bare specifier fails with `failed to import`, while
importing its already-resolved `file:///…/lib/index.js` works. That is why a locally linked
plugin can appear "installed but never active". The repair pass handles it by binding the row
to the resolved URL once; a later recomposition restores the declared specifier and the live
fiber keeps running. Installing from a registry or a git URL places the package inside the
profile and does not need this.

## Compatibility

| | |
|---|---|
| DSH | `0.2.0-rc.2` (`desktop` profile, Web GUI), Node 22.22 — the version this was built and verified against |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Required DSH services | none: `hmr`, `pluginManager`, `profileContext`, `webServer` and `appReady` are all optional, and the plugin loads without any of them and reports what it cannot do |
| Peer range | `@deepseek-ai/dsh >=0.2.0-rc.2 <0.3.0-0`, enforced by the plugin manager before install |
| Platform | host side: any. The `devWatch` loop and the status route assume a local filesystem and a composed Web server |

DSH ships release candidates on a fast cadence, so the peer range is deliberately narrow: when DSH
moves to the next rc, the plugin manager refuses this version until a matching release widens the
range. The deep-reload path also uses Node loader internals, so a Node major upgrade deserves one
manual check — run `POST /check` and expect no `error`.

## Development

```bash
node --test        # unit tests for config normalization; needs no DSH runtime
node --check lib/*.js
```

There is no build step: the files in `lib/` are the code that runs. After an edit, the fingerprint
poll picks it up within about two seconds; to trigger it yourself:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:19387/api/plugin-refresh/reload?path=<repo>/lib' -Method POST
```

The `generation` field in `/status` changes when the in-place swap succeeded.

## Known limits

- **A version replacement that changes the resolved package directory still needs a restart.**
  `app-boot`'s resolution router refuses to replace an existing package name with a different
  directory, version or scope while the process runs. Replacing the *files* at an unchanged
  path is covered; swapping `node_modules/<pkg>` to a different version directory is not.
- **Browser halves are the host's business here.** The plugin manages host-side activation;
  a newly mounted plugin's client bundle reaches an open page through `dsh-client-modules` +
  `dsh-client-hmr`. If that browser graph cannot be updated, the page may need a refresh.
- **The status route is unauthenticated** beyond being bound to the loopback interface, like
  other plugin routes under `/api`. It exposes plugin names, file paths and pass outcomes;
  set `route: ""` to remove it.
- **Rollback is best effort.** If a re-import succeeds but re-activation throws, the previous
  generation is re-activated where possible and the failure is reported in the pass result
  and the log; the process is never left with a disposed plugin and no replacement silently.
- **Repairs are rate-limited.** A repair makes the plugin manager emit the very event that
  schedules the next pass, so one attempt per bundle is allowed per 15-second window. A bundle
  that cannot activate reports `cooling-down` rather than looping.
- **A deliberately switched-off row is not a fault.** A bundle whose rows are all disabled by
  a patch layer (a replaced skin, a preset-scoped tool) is reported healthy, not repairable.
- `@deepseek-ai/schemastery` is imported dynamically: from a `link:` install it is
  unreachable, so `Config` is exported as `undefined` there and the row falls back to raw
  config. Nothing else in the package depends on a non-builtin module.

## Troubleshooting

Read `GET /api/plugin-refresh/status`:

- a pass `error` — the pass itself failed; `HMR transactions cannot be nested` should no
  longer appear (the engine runs inline when it is already inside the queue);
- `repairs[].probe.error` — the *actual* import failure of a broken plugin, which the
  plugin manager only reports as `failed to import`;
- `repairs[].purgedModules > 0` — a poisoned module job was dropped so the retry could read
  the fixed files;
- `repairs[].rebound` — the row was started through its resolved file URL;
- `health[].needsRepair === true` — a selected bundle with no running row.

---

# 中文文档

## 这个插件做什么

**安装完插件后无需重启 DSH，即可让插件立即生效。**

DSH 本身在「在线 profile」下已经能就地加载**全新安装**的 bundle（由 `hmr` 服务 +
plugin-manager 的 `reconcileProfilePatches` 完成）。但有三种情况仍然会退化成「下次启动
才生效」，本插件专门补齐这三种：

| 情况 | 没有本插件时的表现 |
|---|---|
| 安装的依赖名在 profile 里已存在（重装 / 升级 / 本地重新 link） | `installBundle` 在重载**之前**就返回 `application: "restart-required"`，选择被保存，但没有任何东西被挂载。 |
| 插件第一次 import 失败 | Node 会把失败的 module job 缓存住，之后同一个模块 URL 的重试会一直报同样的错——即使文件已经修好，也必须重启进程。 |
| 插件自身文件在同一路径下被改动（重新构建、本地开发重新 link） | 已安装的包在 `node_modules` 下，而官方热重载按设计忽略该目录，运行中的进程会一直用旧代码。 |

## 工作机制

一次串行化的检查流程，在启动后、每次 plugin-manager 操作后、以及被监视文件变化时执行：

1. **深度重载（deep reload）**：找出「模块文件在**路径不变**的前提下已改动」的在线插件，
   按官方 `@deepseek-ai/dsh-hmr` 同样的步骤就地替换：清理 Node ESM `loadCache`
   （必须用 `Map.prototype.delete`，Node 24 需要）与 CJS `require.cache`、重新 import、
   `registry.delete()` 旧一代插件、在**同一批 fiber** 上重新激活，并把原来的 Loader
   `Entry` 接回去，保证 entry 身份、config、诊断信息都不丢。
2. **自动修复（repair）**：对「已被选中但没有运行中的行」的 bundle，先丢弃被污染的
   module job，再直接 import 一次以捕获**真实报错**，然后通过
   `pluginManager.setBundleEnabled()` 重新驱动组合——这是官方路径，profile 写锁和热重载
   队列都由它自己获取。若运行时仍无法解析该行的 specifier，则改用已解析出的文件 URL
   激活该行（见下）。
3. **状态上报**：每个 bundle 的健康表（是否选中、有几行在运行、是否有错误）与有界的
   历史记录，同时输出到日志和 HTTP 接口。

## 安装

```bash
dsh plugin --profile desktop add /绝对路径/dsh_plugin_refresh
```

或在会话里用 `plugin_manager` 工具的 `install_bundle`，参数同样是绝对路径。

## 配置项

见上方英文表格；在 profile 的 `cordis.patch.yml` 里覆盖，例如开发时监视自己插件的目录：

```yaml
- id: plugin-refresh
  config:
    devWatch:
      - /绝对路径/my-plugin/lib
```

## HTTP 接口

仅监听回环地址（与 Web server 一致）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugin-refresh/status` | 配置、快照规模、最近一次检查、bundle 健康表、历史 |
| GET | `/api/plugin-refresh/status?detail=1` | 额外返回每个 entry 的模块快照（文件路径） |
| POST | `/api/plugin-refresh/check` | 立即执行一次检查 |
| POST | `/api/plugin-refresh/repair?bundle=<名字>` | 校验并修复某个 bundle（不带参数则修复全部不健康 bundle） |
| POST | `/api/plugin-refresh/reload?path=<绝对路径>` | 对拥有该文件/目录的插件做深度重载 |

## 开发时的热重载

配置 `devWatch` 指向你的插件目录（或直接调用上面的 reload 接口）后，**改完源码即生效**：
改动会通过每个在线 entry 的模块依赖图被检测到，旧的模块代被清理，插件就地替换。

### 本地安装与「裸模块名」限制

从本地目录安装的插件是 `link:` 依赖，真实路径在 profile **之外**。本运行时为 profile
插件解析模块名时走的是启动时的组合表，而**位于 profile 之外的包无法被它命名**：用裸包名
import 会失败（`failed to import`），而用已经解析好的 `file:///…/lib/index.js` 导入则成功。
这正是「本地 link 的插件显示已安装却一直不生效」的根因。修复流程会先把该行绑定到解析后的
URL 启动一次；之后重新组合时会恢复声明的 specifier，而已运行的 fiber 不受影响。从 npm /
git 安装会把包放进 profile 内，不存在该问题。

## 已知边界

- **改变了「解析到的包目录」的版本替换仍然需要重启**：`app-boot` 的 resolution router
  拒绝对已存在的包名替换目录 / 版本 / scope。**文件内容**在同一路径下变化可以就地生效，
  把 `node_modules/<pkg>` 换成另一个版本目录不行。
- 浏览器半边由 DSH 自己的 `dsh-client-modules` + `dsh-client-hmr` 负责；本插件只管 Host 侧。
  若浏览器模块图无法更新，页面可能需要手动刷新。
- 状态接口除绑定回环地址外**没有额外鉴权**（与其他 `/api` 下的插件路由一致），会暴露插件名、
  文件路径和检查结果；把 `route` 设为 `""` 可完全关闭。
- 回滚是「尽力而为」：重新 import 成功但重新激活失败时，会尽量恢复上一代并在结果与日志中
  报告，不会让进程停在「插件被卸载且没有替代」的状态。
- `@deepseek-ai/schemastery` 是动态导入：`link:` 安装下不可达，因此那里导出的 `Config` 为
  `undefined`，该行退化为「原始 config 直接传入」。包内其余代码不依赖任何非内置模块。

## 排错

打开 `GET /api/plugin-refresh/status` 看：

- 某次检查有 `error`：检查流程本身失败；
- `repairs[].probe.error`：**真实的 import 失败原因**（plugin-manager 只会说 `failed to import`）；
- `repairs[].purgedModules > 0`：丢弃了被污染的 module job，使重试能读到修好的文件；
- `repairs[].rebound`：该行是通过解析后的文件 URL 启动的；
- `health[].needsRepair === true`：某个已选中的 bundle 没有任何在运行的行。

## 本机验证记录（2026-10-11）

- 全新本地 `link:` 安装一个测试插件 → `application: "applied"`，其 HTTP 路由立即返回 200，**未重启**。
- 故意让测试插件的首次 import 失败 → 安装返回 `failed to import`；修好文件后，插件自动检测到
  「已选中但没有运行行」，丢弃被污染的 module job 并用解析后的 URL 启动该行
  （`repairs[].rebound`），其 HTTP 路由随后返回 200，**未重启**。
- 修改本插件自身的 `lib/*.js` → 下一次指纹轮询检测到模块变化，清理 6 个缓存模块并就地替换自身，
  **未重启**；`/api/plugin-refresh/status` 的 `generation` 由 `g56e083` 变为 `g52eb39`，
  且新实例的快照已记录改动后的文件大小，全程没有调用任何接口触发。
- 停止监视的判定修正后，被 patch 故意关闭的 `ui-skin-orca-link` 不再被误报为待修复
  （`needsRepair: false`）。

