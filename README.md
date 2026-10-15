# 钉钉连接器（dsh-plugin-dingtalk-dws）

把**钉钉官方 Workspace CLI（`dws`）**接进 DeepSeek Harness，让 Agent 在对话里直接操作钉钉：

- **工具**：`dingtalk_dws`（执行钉钉命令）、`dingtalk_auth_status`（查连接状态）；
- **面板**：插件自己那一行里显示连接状态灯、当前组织与账号，并提供登录 / 退出登录 / 环境自检；
- **技能与提示词**：自动把「怎么正确用 dws」的契约交给 Agent，不靠猜。

登录态完全由 `dws` 自己管理（Windows 走 DPAPI 加密，存在 CLI 自己的配置目录里），
插件**不保存任何凭证**，只负责发起授权、展示状态、撤销授权。

---

## 1. 前置条件：先装好 `dws`

本节装的是**钉钉官方 Workspace CLI（`dws`）**，不是本插件；本插件只是调用它。
**本插件不会下载或安装 `dws`，它只会去找**，找不到时的行为是：

- `dingtalk_dws` 报错，提示你指定路径；
- 面板状态变成 `找不到 dws`，并在卡片里给出提示。

它也不做任何"自动修复"——没有网络下载、没有 npm 安装、没有静默升级。

### 安装 `dws`

官方支持对话式安装：把下面这句原样发给 DSH 的会话（或任何能执行命令的 Agent），
它会自己克隆、构建并把 `dws` 放好：

```
帮我安装 https://gitee.com/DingTalk-Real-AI/dingtalk-workspace-cli
```

钉钉官方的安装文档（Agent 安装 / 脚本安装 / NPM 安装 / Skills 安装四种方式）：

<https://open.dingtalk.com/>

装好后确认：

```bash
dws version
dws auth status --format json
```

`dws` 自带 `dws upgrade` 可以自我升级（会校验并原子替换，升级前自动备份，
支持 `--rollback`）；`dws upgrade --check` 只检查不升级。经 npm / pnpm / Homebrew
安装的，交由原包管理器升级。

### 插件在哪里找它

按以下顺序，命中即用：

1. 插件配置里的 `executable`（绝对路径）；
2. `$DSH_HOME/dsh-runtimes/dingtalk-dws/dws.exe`（DSH 受管位置）；
3. `$DWS_CONFIG_DIR/bin/dws.exe`（默认在用户目录下的 `.dws\bin\dws.exe`）；
4. `%USERPROFILE%\.local\bin\dws.exe`；
5. PATH 上的裸名字 `dws`（通过 Harness 的 `subprocess.resolveExecutable` 解析）。

> 本插件按 `dws 1.0.59` 的行为编写与测试。换版本后建议先点面板里的**环境自检**
> 跑一次 `dws doctor`。

---

## 2. 安装本插件

前面装的是 `dws`（钉钉官方 CLI），这一节装的是**本插件**。

在 DSH 的会话里发这句话就行：

```
安装插件 github:kviiinh/dsh-plugin-dingtalk-dws
```

它会调用 Harness 自带的 Plugin Manager（`install_bundle`）把包装进当前 profile、
写好 patch，并返回结果。也可以自己直接调：

```
plugin_manager action=install_bundle  target=github:kviiinh/dsh-plugin-dingtalk-dws
```

`github:<owner>/<repo>` 是标准安装 spec，包从仓库直接取；本插件的两个依赖
（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）会自动从 registry 装上。
`git+https://github.com/<owner>/<repo>` 形式同样可用，pnpm 会把它规范化成上面的形状。

> **装完需要重启 DSH。** Host 半边（工具/路由）在进程启动时装配，浏览器半边由
> bundle 路由提供。只有**配置**是热重载的，**代码**不是。
>
> 排查加载问题时，`plugin_manager action=set_bundle` 可以**不重启**就把原始激活
> 错误（含堆栈）报出来——比翻日志或看现象快得多。

### 到这一步就能用了

1. 装好 `dws`（§1）；
2. 装好本插件（上面）；
3. **重启 DSH**。

**不需要改任何配置**——所有配置项都有可用默认值（`executable` 留空会自动查找 `dws`、
`execTimeoutMs` 60 秒、输出上限 60 KB、技能与提示词默认注入），装完即用；
要调才看 §3。

`dws` 的登录态如果还没有，在面板里点一次**登录钉钉**即可（见 §4）。

怎么确认真的通了：

| 看哪里 | 通了的样子 |
|---|---|
| 设置 → 插件 → 钉钉连接器 → 那一行 | 状态灯绿色，显示「已连接」+ 你的组织与账号 |
| 任意会话里问一句「钉钉连上了吗」 | 调 `dingtalk_auth_status`，回答组织与账号 |
| 让它做件事，例如「查一下我今天的日程」 | 调 `dingtalk_dws`，返回真实数据 |

**备选安装路径（不是后续步骤）**——按上面的方式装成功就不需要看：

<details>
<summary>备选：用 dsh CLI 装（pnpm 直通，需要补一步）</summary>

```bash
dsh plugin --profile <profile> add github:kviiinh/dsh-plugin-dingtalk-dws
```

`dsh plugin --profile <name> <pnpm-args...>` 是 **pnpm 的直通入口**，所以这条命令等价于在
profile 目录里跑 `pnpm add <spec>`。

> ⚠️ **它只完成一半。** `pnpm add` 会把包装进 profile 的 `node_modules`、写进
> `dependencies`，但**不会**把这个包登记进 `dsh.profile.bundles`。loader 只装配
> bundles 里列出的包，所以还要手工在 profile 的 `package.json` 里加一行，否则重启后
> 插件不会出现：
>
> ```jsonc
> "dsh": { "profile": { "bundles": [ /* … */ "dsh-plugin-dingtalk-dws" ] } }
> ```
>
> 想一步到位就用上面的 `install_bundle`——它两者都做。

</details>

<details>
<summary>备选：从源码装 / 手工装配（改插件源码时才值得用）</summary>

```bash
# 1) 依赖（@deepseek-ai/dsh-tools 必须与 Harness 正在使用的版本一致）
cd <本包目录>
pnpm install --config.node-linker=hoisted
```

在 `<DSH_HOME>/profiles/<profile>/package.json` 里加依赖与 bundle：

```jsonc
{
  "dependencies": {
    "dsh-plugin-dingtalk-dws": "link:<本包绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其它 bundle…
        "dsh-plugin-dingtalk-dws"
      ]
    }
  }
}
```

```bash
# 2) 让 profile 建立链接
cd <DSH_HOME>/profiles/<profile>
pnpm install
```

> 官方建议是不要手写 profile 的 `package.json` / `cordis.patch.yml`、也不要在
> profile 目录里跑 pnpm，交给 `install_bundle` 更稳妥。上面这段只在改插件源码
> 想免去每次重装时才值得用。

</details>

---

## 3. 配置（可选）

**装完即用，不需要改任何配置。** 这一节是给"默认值不合用"时查的参考。

配置优先级：profile 里 `- id: dingtalk-dws` 那一项 > 包内 `cordis.patch.yml` 默认值。

| 字段 | 默认 | 什么时候才需要改 |
|---|---|---|
| `enabled` | `true` | 想临时停用整个插件 |
| `executable` | `''` | `dws` 不在第 1 节的查找链上时，写绝对路径 |
| `profile` | `''` | 想固定用某个钉钉组织/账号（`corpId:userId` 这类稳定标识）；留空用 `isCurrent=true` 的账号 |
| `execTimeoutMs` | `60000` | 导出、批量类命令容易超时（上限 15 分钟，工具参数 `timeoutMs` 可单次覆盖） |
| `maxOutputBytes` | `60000` | 返回太大、想更省 token（按 UTF-8 边界截断并标注） |
| `exposeRawApi` | `false` | 确实需要调 `dws api`（裸 OpenAPI，默认禁用，逼 Agent 走服务命令） |
| `registerSkill` | `true` | 不想给 Agent 注入钉钉技能与提示词 |

改法：编辑 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 里 `- id: dingtalk-dws`
那一项——配置是热重载的，改完不用重启。本插件当前**没有**做界面写回。

---

## 4. 界面

面板挂在插件**自己那一行**：

**设置 → 插件 → 钉钉连接器 → 点开「包含的组件」里那一行（右侧带 ›）**

座位是 `plugins.row.config`，键为 `<包名>#<行 id>`（本插件即
`dsh-plugin-dingtalk-dws#dingtalk-dws`）。

打开后是一个单页卡片，自上而下：

```
● 钉钉：已连接                     ← 状态灯 + 状态词
  组织      某某科技有限公司        ← 当前登录的组织
  账号      张三                    ← 当前登录的账号
  Profile   (默认账号)              ← 固定账号时显示 corpId:userId
  CLI       PATH: …\dws.exe         ← dws 是从哪儿找到的
  检查于    17:16:45                ← 上次读状态的时刻
  [登录钉钉] [退出登录] [刷新状态] [环境自检]
```

状态灯有四种：`已连接` / `未登录`（含登录态失效）/ `找不到 dws` / `dws 报错`。

| 按钮 | 行为 |
|---|---|
| 登录钉钉 | 调 `dws auth login --no-browser`，把授权链接显示在卡片里让你点开（5 分钟内有效）。已连接时禁用 |
| 退出登录 | 二次确认后调 `dws auth logout`，清除本机登录态 |
| 刷新状态 | 强制重读一次（含 token 刷新，有 30 秒最小间隔） |
| 环境自检 | 跑 `dws version` + `dws doctor`，把结果原样贴出来 |

数据全部来自 Host 的只读路由（`/dingtalk-dws/status`、`/cli-status`、`/login`、`/logout`），
信任围栏在 Host 侧；浏览器半边不做任何直连钉钉的请求。面板带渲染错误边界：
万一子组件抛错，会把错误文字显示出来而不是留一片空白。

> 面板会显示**你的真实组织名、账号名和本机 CLI 路径**（这些都是运行时从 `dws` 读出来的，
> 不是仓库里的内容）。若要截图分享，注意先打码。

---

## 5. Agent 怎么用

Agent 只会看到一个入口工具 `dingtalk_dws`：

```jsonc
// 只读查询
{"service": ["contact", "user", "get-self"], "description": "查我自己是谁"}

// 带参数
{"service": ["calendar", "event", "list"],
 "args": ["--start", "2026-10-15", "--end", "2026-10-16"],
 "description": "列出今天的日程"}

// 含 shortcut / 形如 flag 的值：整体放 args
{"args": ["chat", "+send-text", "--group", "<conversationId>", "--text", "hi"],
 "description": "往群里发消息"}

// 不确定命令时先查帮助
{"args": ["contact", "--help"], "description": "列出通讯录子命令"}
```

插件自动做的事：

- 补 `--format json`（除非调用方已经显式给了 `--format`/`-f`）；
- 按需在最前面插 `--profile`；
- 把 stdout/stderr 里混着的横幅、日志、多个 JSON 文档解析出来，只把 JSON 交给模型；
- 超时后终止子进程并报明确原因；
- 按 UTF-8 边界截断超长输出并标注原始大小。

### 命令发现

本机 `dws` 是「静态端点模式」，`dws schema` 只返回本地有限 Schema（实测为空），
**不要**用它发现命令。用各服务自己的帮助：

```
dws --help                    → 22 个服务清单
dws <service> --help          → 子命令
dws <service> <cmd> --help    → 该命令接受的 flags
```

### 安全策略（硬编码在工具里，违反直接拒绝）

| 拒绝的行为 | 原因 |
|---|---|
| `--yes` / `-y` | 危险操作的确认必须发生在**对话里**：先给用户看操作摘要、拿到明确同意，再在 args 里加 `--yes`。工具不会替用户确认 |
| `--token` | 不允许通过对话传凭证；登录走面板 |
| `--client-id` / `--client-secret` | 不允许覆盖 OAuth 客户端凭证 |
| `api`（`exposeRawApi=false` 时） | 禁止绕过服务命令直连 OpenAPI |

危险操作清单（来自官方 `SKILL.md`）：删文档 / 删块 / 改文档权限、删 AI 表格的 base·table·field·view·record·chart·dashboard、
删日程 / 移除参与者 / 取消会议室、移除群成员 / 撤回机器人消息、撤回 DING、撤销或拒绝审批、删待办、听记全文替换。

---

## 6. 排障

| 现象 | 处理 |
|---|---|
| 面板显示「找不到 dws」 | 先装 CLI（见 §1），或把已有的 `dws.exe` 绝对路径写进配置 `executable` |
| 「未登录」 | 点面板里的**登录钉钉**，在浏览器打开返回的授权链接（5 分钟内有效） |
| 工具报 `AUTH_TOKEN_EXPIRED` | 让用户重新登录，**不要**让 Agent 反复重试 |
| 面板显示 `HTTP 404` / `HTTP 405` | Host 没有注册路由。最常见原因是 `apply` 中途抛错，见下面「Cordis 的三个反直觉语义」 |
| 工具或路由整批消失 | 同上：`apply` 抛错，或 `inject` 里写了根 scope 上不存在的服务 |
| 面板整片空白 | 面板带错误边界，正常会显示错误文字；真空白说明浏览器半边没加载，确认 `package.json` 里有 `dsh.client` 并重启 DSH |
| 状态一直「登录态需刷新」 | `refresh_token` 可能被别的设备轮转掉了；重新登录一次即可 |
| 命令行为与文档不符 | 很可能是 CLI 版本差异。本插件按 `1.0.59` 编写测试；先 `dws version` 确认，再点**环境自检**跑 `dws doctor` |

> 排查加载问题最快的办法不是看日志或截图，而是
> `plugin_manager action=set_bundle`——它会把**原始激活错误**（含堆栈）直接报出来，且不用重启。

> `auth status` 会**刷新** token，而 `refresh_token` 是单设备独占、用后轮转的。
> 所以插件默认用**不触发刷新**的 `profile list` 读状态；只有用户点「刷新状态」才会真正刷新，且有 30 秒最小间隔。

---

## 7. 卸载

在 DSH 的会话里发这句话就行：

```
卸载插件 dsh-plugin-dingtalk-dws
```

或者自己直接调：

```
plugin_manager action=remove_bundle  target=dsh-plugin-dingtalk-dws
```

从源码手工装配的，则从 profile 的 `dsh.profile.bundles` 与 `dependencies` 里删掉本包，
`pnpm install` 后重启 DSH。

插件不写任何全局状态。卸载后除 `dws` 自己的配置目录（`~/.dws`，官方 CLI 的数据目录，**不应删除**）之外没有残留。

---

## 8. 自检

```bash
pnpm test                     # 等于下面五条依次执行
node test/selftest.mjs        # 注册形状 / 真实命令 / 拒绝策略 / 技能注入：31 项
node test/edge.mjs            # 纯文本输出 / 坏参数 / 超时 / 凭证旁路：16 项
node test/http.mjs            # 真实 HTTP 打路由 + 严格上下文回归：22 项
node test/missing.mjs         # 没装 dws 时的降级行为：19 项
node test/prove-strict.mjs    # 证明「严格上下文」测试替身真的有牙齿
```

> 注意：`selftest.mjs` / `edge.mjs` / `http.mjs` 会**真的调用 `dws`**，所以需要先装好 CLI
> 并至少登录过一次；`missing.mjs` 与 `prove-strict.mjs` 不需要。

`selftest.mjs` 用假的 Cordis 上下文 + **真的 `dws.exe`** 跑通全部对外表面。

`edge.mjs` 覆盖边界与失败路径：`--help` 这类**纯文本**输出必须判成功
（`dws` 横幅里那个空 `[]` 会被误当成 JSON 而吃掉正文）、坏命令必须判失败并给可读原因、
空参数拒绝、超时后真正终止子进程。

`http.mjs` 在**真的 HTTP 监听**上发真实请求，验证 `GET /dingtalk-dws/status` 返回 200 且带真实组织名、
错误方法返回 405、退出登录缺确认返回 400、未知子路径落到 fallback；验证**没有 `ctx.subprocess` 时**
工具仍能通过 Node 原生进程跑通；最后用**严格上下文**（复刻 Cordis 的 inject 抛错）验证 `apply` 不再炸掉。

`missing.mjs` 固化「没装 `dws`」时的行为：工具照常注册、`dingtalk_dws` 抛出可操作的错误、
`dingtalk_auth_status` 降级为 `cli_missing`、并且**代码里不存在任何下载/安装/升级动作**。
复现手法是把 `USERPROFILE` 指到一个空目录，让插件的候选路径全部落空（不碰真实文件）。

> 为什么需要这一套：纯静态的假上下文会把服务直接塞进去，所以「注册逻辑看起来对」而真实运行是 404。
> 真实 HTTP + 真实路由表 + 会抛错的 Proxy 替身，才抓得住这类问题。

三个替身都按官方契约实现：

- `test/webserver-double.mjs` —— `register` 的 exact/prefix 两张表、`match` 的
  「先精确后最长前缀」、唯一 fallback 座位、无匹配时裸 404；
- `test/subprocess-double.mjs` —— 同步拒绝已中止的 signal、`done` 解析退出码、
  `terminate()` 走 grace ladder、裸名字按 PATH 解析；并额外导出
  `createStrictContext()`，其属性读取会像真实 Cordis 一样对未注入服务抛
  `cannot get property "X" without inject`；
- `test/prove-strict.mjs` —— 断言 `createStrictContext()` 确实会抛，
  否则 `http.mjs` 里那条回归用例就是摆设。

---

## 9. 实现要点

```
index.js                    Host 半边：配置、dws 运行器、工具、技能、路由
client.js                   浏览器半边：插件自己那一行的面板
cordis.patch.yml            本 bundle 的组成层（一个 insert 行）
test/selftest.mjs           注册形状 / 真实命令 / 拒绝策略
test/edge.mjs               纯文本输出 / 超时 / 边界
test/http.mjs               真实 HTTP 打路由 + 无 subprocess 退路
test/prove-strict.mjs       证明严格上下文替身会抛
test/webserver-double.mjs   ctx.webServer 测试替身
test/subprocess-double.mjs  ctx.subprocess 测试替身 + createStrictContext
```

### Cordis 的三个反直觉语义

`export const inject = ['tools','webServer','connection']`。

1. **读一个没 inject 的服务属性会直接抛错，不是返回 undefined。**
   Cordis 的 Context 是 Proxy：`ctx['subprocess']` 会抛
   `cannot get property "subprocess" without inject`。
   所以像 `ctx[key] !== undefined ? ctx[key] : ctx.get(key)` 这样的「可选探测」
   会在第一个未注入的服务上把整个 `apply` 炸掉——表现为工具、路由、技能全没注册，界面只有 404。
   读可选服务必须用 `ctx.get(name)`（它明确是「不做 inject 要求」的读取入口）。
2. **注入的服务缺一个，插件整个不会被 `apply`**（不是延迟加载，是直接不上）。
   只 inject `['tools']` 时，插件会在 `webServer`/`connection` 就绪前就 apply，
   路由因为 `if (webServer?.register)` 被静默跳过。
3. **把根 scope 上不存在的服务写进 `inject`，插件同样彻底消失。**
   `subprocess` 就是这种情况：它只存在于 Agent 运行环境，所以必须走运行时探测
   （`ctx.get()`）外加 Node 原生 `child_process` 退路。

`skills` 与 `systemPrompt` 同样走运行时探测：少了它们插件仍可用，只是 Agent 少一点上下文。

### 其他要点

- 唯一的进网路径是 `runDws()`；优先 `ctx.subprocess`，退路是 Node 原生 `child_process`，
  两条路返回同样的句柄形状，`AbortSignal` 直连调用方；失败一律转成结构化工具结果，
  不把异常抛进 Harness 主循环；
- 路由先过 `connection.requestRejection()` 信任围栏，拒绝跨站与未认证调用；
- 退出登录必须带 `{confirm: true}`，且浏览器侧还有一次 `window.confirm`；
- 输出解析会滤掉空容器（`dws` 横幅里的 `[]`），否则会把 `--help` 的纯文本正文整个吃掉；
- 界面只挂 `plugins.row.config`（插件自己那一行），不注册 `settings.section`。

---

## 10. 参考

**钉钉 / dws 官方资源**

- 钉钉开放平台（含 Workspace CLI 的 Agent / 脚本 / NPM / Skills 四种安装方式）：
  <https://open.dingtalk.com/>
- CLI 仓库（Gitee，支持一句话安装）：<https://gitee.com/DingTalk-Real-AI/dingtalk-workspace-cli>

**本插件内部**

- 钉钉 Workspace CLI 自身的使用契约（命令发现、产品路由、危险操作清单、错误处理），
  由本插件在运行时以技能形式注入给 Agent，见 `index.js` 的 `bundledSkillContent()`；
- Harness 侧 API 以 `cordis_inspect_query` 的实时结果为准，另可读：
  `@deepseek-ai/dsh-tools`（`defineTool` 与工具注册）、
  `@deepseek-ai/cordis`（fiber 的 `_refresh`：任一注入缺失即 INACTIVE）、
  `@deepseek-ai/dsh-host-webserver`（exact/prefix 路由表与 fallback）。
