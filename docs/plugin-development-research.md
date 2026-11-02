# DSH 插件开发调研报告

- 调研日期：2026-11-02（Asia/Shanghai）
- 调研方法：`skills/agentic-search-strategy`（五阶段：Intake → Plan → Query → Gap check → Synthesis），配套 ledger：`.dsh-research/plugin-dev-ledger.md`
- 事实基准：本机安装版 `@deepseek-ai/dsh` **0.2.1-rc.5**（`/home/z/.npm-global/lib/node_modules/@deepseek-ai/dsh/`）；公开文档取 GitHub `master`（仓库 `package.json` 已到 `0.2.2-alpha.2`，比本机新一个版本线，见 §7 证据限制）

---

## 1. 一句话结论

**DSH 插件就是 Cordis 插件**：一个导出 `apply(ctx, config)` 的 ES 模块（可选 `name` / `inject` / `Config`），通过 `ctx` 注册能力；要“装进产品”，再把它包成一个声明了 `dsh.bundle.patch` 的 npm 包（bundle），用 `dsh plugin --profile <p> add <包>` 装进 profile。官方已经自带 4 个指导 skill，其中 **`cordis-plugin-development`** 就是“如何开发/安装/验证 DSH 插件”的主指导；社区另有一个可安装为 skill 的知识库 **`dsh-primer`**（原 `dsh-plugin-guide`）。

| 问题 | 答案 | 置信度 |
|---|---|---|
| 插件最小契约 | `export function apply(ctx, config)`，可选 `export const name` / `inject` / `Config` | 高（官方教程） |
| 本地怎么快速试 | `dsh web --patch ./cordis.yml`，patch 里 `insert` 一个绝对路径的插件模块 | 高（官方教程） |
| 怎么做成可分发的包 | 包 `package.json` 声明 `dsh.bundle.patch`，`dsh plugin --profile web add <pkg\|./dir\|github:...>` | 高（官方教程 + CLI） |
| 官方指导 skill | `cordis-plugin-development` + `cordis-composition-reference` + `editing-cordis-compositions` + `agent-experience` | 高（本机已安装并加载） |
| 社区指导 skill | `dsh-primer`（npm 0.4.1，注册为 agent skill + `dsh-plugin-dev` CLI） | 中（第三方 README，未安装验证） |

---

## 2. 插件最小形态（官方教程原文要点）

来源：[docs/user/develop/basic/index.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)（官方，primary）

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'
export const inject = ['tools']          // 可选：声明依赖的服务，Cordis 会等它就绪再 apply

export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)          // 所有 ctx 注册在卸载时自动清理
  ctx.effect(() => {                     // 需要显式清理的资源（连接、定时器）
    const t = setInterval(() => {}, 5000)
    return () => clearInterval(t)
  })
}
```

- **三种形态**：函数模块（最常用）、`export default { name, inject, apply }` 对象、`class X extends Service`（只有需要对外提供服务时用）。
- **`inject`** 是依赖声明，不是 import：服务缺失时插件停在 `PENDING`，服务回来再自动加载（生命周期状态机 `PENDING → LOADING → ACTIVE / FAILED → UNLOADING → DISPOSED`）。
- **清理语义**：`ctx.on` / `ctx.tools.register` / `ctx.effect` 都由框架追踪；卸载按逆序执行 disposer，但多个异步 disposer 并发、无顺序保证——有顺序要求的清理要放进同一个 `ctx.effect` 里串行 await。
- **配置**：导出同名 `Config`，必须是 **Schemastery** schema（`@deepseek-ai/schemastery`，实现 Standard Schema 接口），不能是普通对象；加载时校验并填默认值，非法配置直接加载失败。改配置走 HMR：卸载旧实例、加载新实例。
- **加工具**：`inject = ['tools']` + `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`，见 [tool.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md)。

来源：[framework/index.md（生命周期）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md)、[config.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)（官方，primary）

---

## 3. 从“本地能跑”到“装进 profile”：bundle 与 profile 两层清单

来源：[docs/user/develop/basic/publish.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)（官方，primary）

**两个概念，两个清单，不要混：**

| | 声明位置 | 回答的问题 |
|---|---|---|
| **bundle**（你要写的、要分发的） | `package.json` 的 `dsh.bundle.patch` → 指向 `cordis.patch.yml` | 这个包贡献了什么？一份“插入/覆盖插件行”的配置层 |
| **profile**（用户启动的） | `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles`（有序）+ 自己的 `cordis.patch.yml` | 这套运行环境由哪些 bundle、按什么顺序组合 |

最小 bundle（Host-only，无需依赖/构建）：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

**安装与层序**（官方 + 本机 `dsh --help` 交叉验证）：

```bash
dsh plugin --profile demo add ./hello-plugin      # 转发给 profile 目录里的 pnpm，并自动追加到 dsh.profile.bundles
dsh --profile demo --dump-config                  # 不启动即可看到 "# == dsh-hello-plugin" 层
dsh --profile demo
dsh plugin --profile demo remove dsh-hello-plugin # 依赖和层一起删
```

组合顺序（后者按行覆盖前者）：**各 bundle patch（按 `bundles` 顺序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 每个 `--patch` overlay**。
两个作者必须知道的后果：

1. 你的 patch 可以按 `id` 覆盖前面层的行，但 **`config` 是整块替换、不深合并**，没写的键会丢，必须全部重述；
2. 用户可以在自己的 profile patch 里覆盖你的行，所以把“用户大概率会保留的默认值”放进 schema。

**版本门禁**：`"engines": { "dsh": ">=0.2.1-0 <0.3.0" }`；没有 `engines.dsh` 则回退检查 `@deepseek-ai/dsh*` 的 peer 范围，不满足则拒绝安装/启动，可用精确版本豁免（`dsh plugin ... allow-version <pkg@ver> --dsh-version <v> --accept-risk`、profile 的 `compatibility.json`）。本机第三方插件实例：`dsh-rewind-plugin` 声明 `"dsh": ">=0.2.1-rc.1 <0.3.0-0"`（`/home/z/.dsh/profiles/web/node_modules/dsh-rewind-plugin/package.json`）。

**从 git 安装的坑**：git 拉的是源码不是产物，作者必须提供自包含的 `prepare` 构建；pnpm ≥10 默认拒绝执行，用户需在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 放行。想避免这一步就发 npm（预构建 `lib/`）或发 `pnpm pack` 的 tarball。

**用 agent 安装（本 harness 内）**：`cordis-plugin-development` 规定用普通 workspace 文件写 bundle，然后调 `plugin_manager`（`action: install_bundle`，`target` 传**绝对包目录**），不要手写 profile 的 `package.json`/`cordis.patch.yml`、不要在 `$DSH_HOME` 下建包、不要在 profile 里跑 pnpm。`plugin_manager` 每个动作都需要 approval 或 danger-full-access；安装结果看返回的 `application`（`applied` / `overridden` / `restart-required` / `failed`），不要靠日志或进程判断。

---

## 4. 扩展点地图（Host 侧 / Client 侧）

证据：本机 `cordis_inspect_query`（`Service`/`Event` 目录，实时=primary）+ 各包 README（安装版）。

| 需求 | 机制 | 侧 |
|---|---|---|
| 加一个模型可调用的工具 | `ctx.tools.register(defineTool(...))` | Host |
| 加系统提示词段落 / 变量 / 上下文 | `ctx.systemPrompt.section()` / `.variable()` / `.context()` | Host |
| 监听/改写 agent 流程 | `agent/pre-step`、`agent/request`、`agent/created`、`agent/assistant-stream`、`tools/pre-execute` 等事件（不接管决策必须 `return next()`） | Host |
| 对外提供可替换能力 | Cordis `Service` 类 + `inject`（三角色：Service Definition / Provider / Consumer，见 [practice/index.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/index.md)） | Host |
| 会话状态投影 | `ctx.sessionProjections.register({ key, stateVersion, init, apply, wire })`（纯同步 fold，替代手写 `session/event` 扫描） | Host |
| 人类斜杠命令 | `ctx.commands.register({ name, description, input, handler })` | Host |
| Web UI 页面/面板/小组件 | `package.json` 声明 `dsh.client`（`platform: "web"`、`inject`、`immediately`），`./client` 导出 `window.__ModuleLoader__.load({ id, factory })`，在 `apply` 里注册 slot | Client |
| 主题 | 主题 token（`--dsw-alias-*`）与 `ctx.theme`；客户端插件必须用宿主 token，不硬编码颜色 | Client |
| 让 agent 拥有一个新 skill | `ctx.skills.registerProvider(...)`（`dsh-primer` 就是这么做的） | Host |

**Slot 注册示例（模板）**：`templates/decoration/`（`package.json` + `cordis.patch.yml` + `index.js` + `client.js` + `locale/en.json` + `icon.svg`），在 skill base dir 内，安装时先复制到 workspace 再改，不要原地安装/在 asar 内 shell 读取。

**改完怎么验证**：`cordis_inspect_query`（`Service` 查方法签名、`Event` 查事件契约、`Config.listConfigs` 查已挂载插件的 JSON Schema、`Slots.listSubTree` 查真实 slot 树、`Theme.listTokens` 查 token）→ 装好后用批准-free 的 inspect 确认新行，再用页面/工具实际跑一次。

---

## 5. 指导 skill 清单（本问题的核心答案）

### 5.1 官方随包发布、每个会话 catalog 里都有的 4 个

路径：`<dsh>/node_modules/@deepseek-ai/dsh-agent-preset/skills/<name>/SKILL.md`；由 preset 的 `skill-filesystem` 以 `customSkillDirs` 挂载（`dsh-web-app/presets/cordis.patch.yml:122-128`），因此 `standard` / `ptc` / `cordis` 等 preset 都能看到。

| skill | 何时触发 | 内容 |
|---|---|---|
| **`cordis-plugin-development`** | 设计/评审/新增/启用/禁用/安装/配置/调试插件、bundle、功能、页面、面板、工具、MCP 连接；以及“没有指定落点的视觉/挂饰/小组件需求” | **主指导**：设计→选扩展点→拷贝模板→`install_bundle`→验证的完整流程；强调 inspect 优先、包 README 次之、源码兜底；附 6 篇 references + 2 套模板 |
| `cordis-composition-reference` | 读写 bundle patch 或 agent preset，需要 Loader YAML 方言（insert / 按 id 覆盖 / group / disabled / isolate / `!!js`）或可安装包清单 | 参考手册（过程在另外两个 skill 里） |
| `editing-cordis-compositions` | 创建/修改/校验 agent preset 或其他 composition，判断 Host 还是 preset 侧 | preset 声明格式、放置规则、挂载校验 |
| `agent-experience` | 写模型可见的工具定义、设计 skill / 上下文加载 / 多步工作流 | 工具与 skill 的信息可发现性、上下文经济性 |

`cordis-plugin-development` 的 references 本身就是二级指导材料：`host-plugin.md`（bundle 清单、locale/图标、安装、Host 导出与 Config）、`ui-plugin.md`（Client 清单、模块加载器、slot 注册）、`mcp-bundle.md`（用纯配置接 MCP server）、`practices.md`（扩展点/上下文/状态的稳定性与性能选型）、`user-actions.md`（UI 动作与 agent 工具共享操作）、`verification.md`（无浏览器控制时的验收）。**本仓库的 `skills/agentic-search-strategy` 也是按同一套 SKILL.md 约定写的**（见 `skills/agentic-search-strategy/SKILL.md`）。

### 5.2 官方仓库里的贡献者 skill（不在安装包里，clone 源码才有）

`.agents/skills/` 下有 23 个：[agent-experience](https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/skills)、`dsh-code-review`、`dsh-client-ui-ux`、`dsh-responsive-ui`、`dsh-session-projection`、`cordis-styling-nitpicking`、`dsh-error-handling`、`dsh-create-upgrade-guide`、`dsh-find-simplifications`、`dsh-pre-push-checks`、`dsh-prose-standard` 等。它们是**改 DSH 仓库本身**的规范（代码评审、UI/UX、性能、会话投影迁移），写第三方插件时 `dsh-client-ui-ux` / `dsh-session-projection` / `cordis-styling-nitpicking` 有参考价值，但触发条件不是“写插件”。

### 5.3 社区“可安装的指导 skill”（第三方，非官方）

| 资源 | 形态 | 说明 | 核实情况 |
|---|---|---|---|
| [**dsh-primer**](https://github.com/PerryLink/dsh-primer)（原 `dsh-plugin-guide`） | npm bundle，装好后**注册为 agent skill** + 自带 `dsh-plugin-dev` CLI | 官方文档逐字镜像（429 页）、版本矩阵、0.1.6→0.2.1 迁移“接缝”、30+ 实测坑、`new/check/verify/seams` 子命令。安装：`dsh plugin --profile web add dsh-primer` | npm registry：`dsh-primer@0.4.1`，`engines.dsh: ">=0.2.1-0 <0.3.0"`（与本机 rc.5 兼容）；旧包 `dsh-plugin-guide` 已 deprecated |
| [**hello-dsh**](https://github.com/pingfanfan/hello-dsh) | 教程仓库 + `examples/skills/` 22 个中文 skill | 含 `dsh-first-plugin`、`dsh-plugin-dev`（写代码插件的完整规则）、`dsh-skill-dev`（写 skill 的规则）、`dsh-troubleshoot`。两条路线：Markdown skill（5 分钟）vs TypeScript 插件（30+ 分钟） | 社区教程，部分结论基于 0.1.0-rc.6，已过时（见 §7） |
| [create-dsh-plugin](https://registry.npmjs.org/create-dsh-plugin/latest) | npm 脚手架（`npx create-dsh-plugin`，v0.2.3） | tool / events / webui 模板 + `--verify` 冒烟 | 仅 registry 元数据，未运行 |
| [dshbase.com](https://dshbase.com/plugins/hello-dsh/)、[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com/)、本机 `dshmarket` 插件 | 插件目录 / 市场 | dshbase 声称 133 个插件并做 install-tested；本机 profile 已装 `dshmarket`、`dsh-better-sidebar`、`dsh-rewind-plugin` | 生态计数不可靠（topic 标签混入无关仓库） |

### 5.4 想自己写一个“指导 skill”放哪

来源：[`dsh-skill-filesystem` README](file:///home/z/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/README.md)（安装版，primary）

- 形式：目录包 `<name>/SKILL.md`，或顶层扁平文件 `<name>.md`（**不递归发现**嵌套 `SKILL.md`）。
- frontmatter：必填 `name`（kebab-case）、`description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。
- 扫描根（rank 升序，重名按优先级解析）：`.dsh/skills`(100) → `.agents/skills`(200，项目根 = 最近含 `.git` 的祖先，否则 cwd) → `customSkillDirs`(300) → `~/.dsh/skills`(400) → `~/.agents/skills`(500) → bundled(600)。
- catalog 与正文分离：发现只解析 frontmatter，**每次加载都重读文件**，所以改正文无需版本号/缓存失效；目录有 watch，新增/改名/删除对下一步可见。
- 也可以由插件用 `ctx.skills.registerProvider(...)` 提供（`dsh-primer` 的打包方式）。

> 实测提示：本仓库 `skills/agentic-search-strategy` 在本次会话 catalog 中可见，但 `skills/` 不在 `dsh-skill-filesystem` 的默认根列表中——说明本会话还叠加了额外根（preset 的 `customSkillDirs` 或启动期配置）。要让自己写的 skill 稳定被发现，放进上面列出的默认根之一最稳。

---

## 6. 版本、兼容与坑（写插件前必须知道）

1. **开发预览、破坏性变更**：官方 README 明写 “developer preview — THERE WILL BE COMPATIBILITY-BREAKING CHANGES”；仓库 master 已在 `0.2.2-alpha.2`，本机安装是 `0.2.1-rc.5`，npm `latest` 也是 rc.5（prerelease）。**官方文档读 master 时要对照本机版本**。
2. **`engines.dsh` 是否真的强制，文档自相矛盾**（须标记）：`dsh-app-boot` 与 `plugin-manager` README 说安装/启动前会校验并拒绝不满足的包；但 `dsh-package-manifest` README 的 Known Limitations 说“当前安装器与加载器不强制 `manifestVersion`/`engines.dsh`”。以运行路径文档为准（app-boot + plugin-manager），但**未在本机实测**（profile 目录受沙箱只读，`dsh --dump-config` 写 `cordis.yml` 失败）。
3. **patch 的 `config` 整块替换**：覆盖别人的行必须重述全部键；`--patch` 是 insert 语义，重复 patch 同一插件会出现重复挂载（社区实测，版本较旧）。
4. **组合冻结语义**：`agent-preset` 的“live agent 组合保持稳定”，preset 改动只影响**之后新建**的 agent；已有会话与其子会话保留启动时的插件版本。
5. **Host vs preset 放置**：Host 插件提供共享服务（tools/prompt 注册表、agent loop、session、sandbox、模型路由）；preset 插件贡献限定作用域的工具/persona/提示词/策略。提供服务的 preset 插件必须把 provider 和消费者隔离在同一 realm。
6. **Client 侧热更**：客户端插件代码要热更必须有 `pnpm run dev:web` 在跑；reload 后 React 状态丢失；替换 modules bootstrap 需要刷新页面；linked 包改代码要重建+重启。
7. **HMR 限制**：替换失败不回滚（旧版本不恢复），停在 inactive；只在 DSH 拥有的组合边界做兼容校验（preset 行、`ctx.loader.create()` 的入口不受检）；只改 `package.json` 不触发。
8. **安全边界**：安装的 Host 代码在进程内执行、**在工作区沙箱之外**；`plugin_manager` 所有动作（含 `list_plugins`）都要 approval / danger-full-access；构建脚本放行（`approvedBuilds`）必须由用户明确同意；兼容性检查不是对抗恶意代码的沙箱。
9. **别往 session 里塞新事件类型**：`Session.append()` 无法设置 `ignorable: true`，未知类型会导致会话无法重新打开；`appendPluginRecord()` 仅限 DSH 实验包。
10. **社区结论已过时的一例**：hello-dsh 说“Web profile 默认禁用 skill 插件”（0.1.0-rc.6）。本机 0.2.1-rc.5 里 `dsh-web-app` 的 base patch 关掉了根级 `skill-filesystem`/`tool-skill`，但每个 preset 又各自挂了它们，所以**当前 Web 会话有 skill 能力**（本会话 catalog 就是证据）。

---

## 7. 建议的最短路径（按目的选一条）

**A. 只想快速验证一个想法（10 分钟）**

```bash
# 1) 写 scratch-plugin/src/my-plugin.ts（apply + inject）
# 2) 写 scratch-plugin/cordis.yml：
#    - insert:
#        - id: hello
#          name: '/absolute/path/to/scratch-plugin/src/my-plugin.ts'
dsh web --patch ./scratch-plugin/cordis.yml
```

**B. 要一个能反复安装/分享的插件（30 分钟起）**

1. 先加载 `cordis-plugin-development`（或直接抄它的模板 `templates/decoration/`），按 `references/host-plugin.md` 补齐 `package.json`（`dsh.bundle.patch`、`files`、`locale/*.json`、`icon`）与 `cordis.patch.yml`；
2. workspace 内自查语法与清单；
3. 让 agent 调 `plugin_manager install_bundle`（`target` = 绝对包目录），读 `application` 字段；
4. 用 `cordis_inspect_query` 确认新行/新能力，再用真实页面或工具验收。

**C. 想先让 agent“别乱编 API”**：装社区知识库 skill

```bash
dsh plugin --profile web add dsh-primer      # 装好后会话 catalog 出现 dsh-primer skill + dsh-plugin-dev CLI
npx dsh-plugin-dev new my-plugin && npx dsh-plugin-dev check --json
```

---

## 8. 证据限制与未决问题（诚实标注）

1. **官方文档站点无法直连**：`deepseek-harness.github.io` 与 `raw.githubusercontent.com` 经本环境 fetch 代理返回 404（github.com 的 blob/tree 页面正常），因此官方内容均取自 **GitHub 上的 markdown 源文件**；站点导航、版本切换器未验证。
2. **文档 master（0.2.2-alpha.2）≠ 本机（0.2.1-rc.5）**：`plugin_manager` 参数细节、`--dump-config-schema`、plugin-index 行为在 rc.5 是否一致未逐一实测。
3. **`engines.dsh` 强制执行的文档冲突**（§6.2）未通过实测裁决。
4. **第三方 skill（dsh-primer / hello-dsh）未安装验证**，其“坑”与版本矩阵按作者自述采信，标为 secondary。
5. **生态计数不可靠**：GitHub `dsh-plugin` topic 页约 2.6 万、oh-my-dsh 约 1.6 万，均含无关仓库，不等于可用插件数。
6. 未找到公开的“客户端 UI slot 插件”逐步教程；该部分依据安装版 `references/ui-plugin.md`、`dsh-client-modules` / `dsh-client-ui-schedule` README 与本机 slot inspect。

---

## 参考来源

**官方（primary）**
- 仓库与文档：https://github.com/deepseek-ai/deepseek-harness （`docs/user/develop/basic/{index,tool,config,publish}.md`、`docs/user/develop/framework/{index,service,events}.md`、`docs/user/develop/practice/index.md`、`.agents/skills/`）
- 安装版包文档：`@deepseek-ai/dsh` README、`dsh-app-boot`、`dsh-plugin-manager`、`dsh-hmr`、`dsh-skill*`、`dsh-plugin-market` 的 README；`dsh-package-manifest/lib/types/types.d.ts`
- 运行期真值：本机 `cordis_inspect_query`（Service / Event / Config / Slots / Theme）、`dsh --help`、`dsh plugin --help`

**社区（secondary）**
- dsh-primer：https://github.com/PerryLink/dsh-primer ／ `https://registry.npmjs.org/dsh-primer/latest`
- hello-dsh：https://github.com/pingfanfan/hello-dsh ／ https://dshbase.com/plugins/hello-dsh/
- create-dsh-plugin：https://registry.npmjs.org/create-dsh-plugin/latest
- 中文教程：[阿里云：DSH plugin 打包成 bundle](https://developer.aliyun.com/article/1763001)、[阿里云：DSH 插件开发指南](https://developer.aliyun.com/article/1766409)、[腾讯云：用 DeepSeek + Harness 做 Agent](https://cloud.tencent.cn/developer/article/2750220)
- 市场目录：https://dshbase.com 、https://awesome-dsh-plugin.com
