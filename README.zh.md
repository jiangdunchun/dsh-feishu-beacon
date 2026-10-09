# dsh-feishu-beacon

[![npm](https://img.shields.io/npm/v/dsh-feishu-beacon)](https://www.npmjs.com/package/dsh-feishu-beacon)
[![license](https://img.shields.io/npm/l/dsh-feishu-beacon)](LICENSE)
[![downloads](https://img.shields.io/npm/dm/dsh-feishu-beacon)](https://www.npmjs.com/package/dsh-feishu-beacon)
[![stars](https://img.shields.io/github/stars/jiangdunchun/dsh-feishu-beacon)](https://github.com/jiangdunchun/dsh-feishu-beacon)

[English](README.md) · **简体中文**

把 DeepSeek Harness agent 的进展，以及那些需要你回来的时刻，推送到飞书群。

长时间运行的 agent 有两个麻烦：你不想一直盯着它，但一旦走开，又会错过它「没有你就无法继续」的那些时刻。这个插件同时解决这两件事——agent 会主动把自己的里程碑报给一个你配置的飞书机器人，而提问、授权请求和失败则**无论 agent 是否记得上报**都会被推送。

```text
PROGRESS
Task: 修复不稳定的部署
Workspace: beacon-project
Time: 2026-09-21 14:20:03

第 2/4 步完成：问题出在重试定时器的竞态，不在部署脚本。
```

## 你会收到哪些通知

| 触发时机 | 收到什么 |
|---|---|
| agent 到达它认为值得告知你的里程碑 | 它自己写的内容，标题为 `PLAN`、`PROGRESS`、`DECISION` 或 `DONE` |
| agent 需要你的回答 | `Answer needed`，包含每个问题与**每个选项及其说明** |
| agent 需要对敏感操作授权 | `Authorization needed`，包含工具名与原因 |
| 一次运行失败 | `Turn failed`，包含错误信息 |

**运行成功时不会推送任何东西。** 如果你做完一件事、手机却毫无动静，那正是它在正常工作：每次运行都汇报是噪音，而这个插件存在的意义就是避免噪音。

## 开始之前

- 已安装 `dsh` CLI，并且有 **web** profile。
- 一个你有权限添加机器人的飞书群。

## 安装

```powershell
dsh plugin --profile web add dsh-feishu-beacon
```

然后**重启 harness**。设置页面只在启动时加载，所以正在运行的 harness 还看不到它。

## 配置步骤

### 1. 在飞书里创建机器人

飞书官方文档有完整的图文步骤——自定义机器人的设置入口在哪、如何复制 Webhook 地址、签名校验怎么工作：[自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)。

简版步骤：

1. 打开你想接收通知的飞书群。
2. **设置 → 群机器人 → 添加机器人 → 自定义机器人**。
3. 起个名字，复制它给出的 **Webhook 地址**。
4. 如果机器人启用了签名校验，把 **签名密钥** 也复制下来。

### 2. 填进插件

打开 **设置 → Feishu beacon**，粘贴 Webhook 地址。地址必须以 `https://` 开头。如果你的机器人校验签名，把密钥也粘上；不校验就留空。

这里**没有保存按钮**——你输完即已写入，字段下方的状态行会告诉你是否生效。如果某个值被拒绝，它会留在输入框里并附上原因。

### 3. 点「Send test」

`Send test` 是页面上唯一的按钮。它会立刻用**页面当前显示的值**发一条消息，因此一次性证明三件事：地址对、密钥对、你的手机能看到这个群。这条消息一两秒内就会出现在飞书里。

如果页面报错，见[如果它不工作](#如果它不工作)。

### 4. 告诉 agent 去汇报

里程碑上报是 agent 自己的判断，所以需要你交代一次：

> report your progress through dsh-feishu-beacon

提问、授权请求和失败**不需要**交代，从这一刻起就会自动推送。

## 可以调什么

全部都在同一个设置页上，而且**全部立即生效**，不需要重启任何东西。

| 设置项 | 作用 |
|---|---|
| **Enabled** | 总开关。关闭时完全不推送。 |
| **Notify on questions** | agent 需要你回答时推送。 |
| **Notify on approvals** | agent 需要授权时推送。 |
| **Notify on failed turns** | 运行失败时推送。 |
| **Title prefix** | 加在每个标题前面，用来区分不同机器/环境，例如 `[HOME-PC] PROGRESS`。 |
| **Host URL in messages** | 加一行 `Open at:`，指回你的 harness。详见下文。 |
| **Max characters** | 整条消息长度上限，默认 `1800`。超出部分会被截断并以 `...` 结尾。 |
| **Signing secret** | 仅在机器人校验签名时需要。 |
| **Webhook URL** | 机器人的 Webhook 地址。 |

三个通知开关是**故意独立**的：关掉一个不会影响另外两个。

两个凭据字段只显示 **stored** 或 **not set**，不显示值本身；只有在确实存了凭据时，旁边才会出现 `Clear`。你的 Webhook 和密钥保存在 harness 上，永远不会被发回浏览器。

### 关于「Host URL in messages」

这个字段只控制一行——`Open at:`——其它什么都不影响。它的意义在手机上：飞书通知本身不携带任何会话信息，那一行就是你点回 harness 的入口。

- **在跑 harness 的同一台机器上看通知？** 留空即可。它会回退到 `DSH_WEB_URL`，harness 自己会设置。
- **在手机上看通知？** 回退值通常是 `http://127.0.0.1:<端口>`，这个地址在手机上指向手机自己，点了打不开。请填一个手机能访问的地址——同一 WiFi 用局域网 IP，外网用隧道/反代地址。

当这个字段和 `DSH_WEB_URL` 都没有设置时，这一行会被直接省略。

## 从 0.1.x 升级

**0.2.x 要求 dsh 0.2，0.1.1 要求 dsh 0.1.x——两者互不兼容。** 跑 dsh 0.2 就装 0.2.x；还在 dsh 0.1.x 就留在 0.1.1。

配置存放位置也变了：现在存在当前 profile 的 patch 层里，不再存于 `settings.yaml`。升级后请重新填入 Webhook 地址和签名密钥。

## 如果它不工作

**装完后设置里找不到这个插件。**
`dsh plugin add` 即使在安装失败时也会报成功，而没被登记为 bundle 的包永远不会加载。检查 `$DSH_HOME/profiles/web/package.json`，确认 `dsh-feishu-beacon` **同时**出现在 `dependencies` 和 `dsh.profile.bundles` 里。如果没有，重跑安装并留意 pnpm 的报错。最常见的原因是 `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 里有个未决定的 `allowBuilds:` 条目——把它答成 `false`（对已发布的包来说构建脚本没有用），然后重新安装。

**「Send test」失败。**
确认 Webhook 地址以 `https://` 开头；如果机器人校验签名，确认密钥与机器人一致。页面上的 `502` 表示**飞书那边**拒绝了这条消息。

**我没收到通知。**
先确认这一次**应该**收到：运行成功是不会有任何推送的。然后检查 **Enabled** 与对应的 **Notify on…** 开关。如果是一次失败却没收到，那就是推送本身失败了——harness 日志里会有一条 **warning**，而绝不会是 error，因为推送失败不允许影响你的会话。

**通知收到了，但 `Open at:` 链接打不开。**
那个地址从你看消息的设备访问不到。见[关于「Host URL in messages」](#关于host-url-in-messages)。

**消息被截断了。**
超过 **Max characters**（默认 1800）就会截断。想接更长的内容可以调大，但请注意：手机上过长的消息反而没用，而手机正是这个插件的目标场景。

## 已知限制

- **回复不会回来。** 自定义机器人 Webhook 只能发。你无法在飞书里回答问题——消息会提示你回到 harness。
- **不会重试。** 一次失败的推送就是永久丢失。这也是为什么工具路径会把失败告诉 agent，而只有事件路径保持沉默。
- **极长会话可能重复收到同一条通知。** 去重是有容量上限的，超过之后会从头开始。
- **飞书必须能访问到 Webhook，你的 harness 也必须能访问飞书。** 企业网络只要挡住任一方向，消息就会静默丢失——依赖它之前先用 `Send test` 验证。

## 卸载

```powershell
dsh plugin --profile web remove dsh-feishu-beacon
```

这会把包移除，但**不会**把它的名字从 profile 的 bundle 名单里删掉：dsh 只在**安装时**协调 `dsh.profile.bundles`，所以卸载会留下那个名字，下次启动就会尝试加载一个已经不存在的 bundle。请打开 `$DSH_HOME/profiles/web/package.json`，把 `"dsh-feishu-beacon"` 也从 `dsh.profile.bundles` 里删掉，然后重启 harness。

你的 Webhook 地址与签名密钥仍留在 profile 的配置文件（`cordis.patch.yml`）里。如果想让它们一并消失，把那行也删掉。

## 给开发者

以下内容关于插件本身的开发。

### 目录结构

仓库根目录**就是**这个包：

```text
dsh-feishu-beacon/
├── package.json          exports / files / dsh.bundle / dsh.client
├── cordis.patch.yml      bundle 挂载行与组合配置基座
├── README.md             英文版
├── README.zh.md          中文版（本文件）
├── lib/
│   ├── index.js          宿主半：传输、事件层、工具、Config、路由
│   └── client.js         客户端半：设置页面
└── test/
    ├── smoke.mjs              宿主冒烟测试
    ├── client-smoke.mjs       客户端契约测试
    ├── no-cjk.mjs             零 CJK 强制检查
    ├── cordis-mount.mjs       真实注册表挂载检查
    ├── install-load.mjs       已安装 profile 加载检查
    ├── live-contract.mjs      运行中 harness 契约检查
    ├── pack-install-check.mjs 发布清单打包检查
    ├── profile-check.mjs      组合 profile 验收检查
    └── live-check.mjs         一次性真实 webhook 检查（不随包发布）
```

只有 `lib/`、`cordis.patch.yml`、两个 README 和 `LICENSE` 会随包发布；`test/` 下的一切都留在仓库里。用 `npm pack --dry-run` 核对。

所有面向用户和面向模型的字符串都集中在两半各自的 `MESSAGES` 块里，因此翻译或把某个标签做成可配置，只需要改一处。

### 工作原理

两层，缺一不可：

- **工具层。** 只有模型自己能分辨「测试刚通过」和「架构已定稿」，所以里程碑上报是一个工具 `dsh_beacon`，由模型主动调用。参数是 `message` 和可选的 `kind`（`plan`/`progress`/`decision`/`done`）。
- **事件层。** 工具只在模型记得调用时才触发，而 `ask_user_question`、`approval/asked` 和失败的 `turn/end` 恰恰是用户必须回到电脑前的时刻。这三类由会话事件推送，与模型是否记得无关。

插件导出一个 `Config` schema（每个字段都是 `.volatile()`），并通过 `ctx.settings.update` 写回；Loader 会用该 schema 解析这一行的配置并交给 `apply`，每次编辑后重新执行 `apply`。配置有两层，后者覆盖前者：`cordis.patch.yml` 的 `config:` 块，然后是 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里这一行的 `config:`。

设置页面通过两条 HTTP 路由通信：`/api/dsh-feishu-beacon/config`（`GET` 脱敏视图，`POST` 补丁）与 `/api/dsh-feishu-beacon/test`（`POST` 一条测试消息）。`POST` 的请求体就是配置补丁：普通字段合并写入，`clearWebhook` / `clearSecret` 清除已存凭据，而空的凭据字符串表示「保留已存的值」。

`webhookUrl` 与 `secret` 声明为 `role("secret")`，因此 dsh 会把它们从所有面向网络的视图中剥离。由于「空」和「未设置」是两种不同的存储状态，清除走的是声明式 `unset`，而不是写入空字符串。

三个飞书细节如果在实现时弄错会**静默失败**：信封（`msg_type: "text"`、`content.text`）、成功码（缺失代表成功，存在且非零代表失败）、签名（以 `"<timestamp>\n<secret>"` 为 HMAC-SHA256 密钥、消息体为空、摘要为 base64）。其它聊天平台这三者都不同，所以「改一下 URL 就能用」是错的。

### 参与开发

```powershell
npm install --ignore-scripts --cache .npm-cache

node test/no-cjk.mjs          # 所有随包发布的文件都是纯 ASCII（无 CJK）
node test/smoke.mjs           # 宿主半：推送、去重、路由、热配置
node test/client-smoke.mjs    # 客户端半：加载器契约、slot、控制器、表单
node test/cordis-mount.mjs web   # 真实 Cordis 注册表挂载并重新 apply
node test/install-load.mjs web   # 已安装的 profile 链接可解析并成功 apply
node test/pack-install-check.mjs # 发布清单里的文件能组合成 profile
node test/live-contract.mjs      # 运行中的 harness 符合文档承诺的契约
```

`npm pack --dry-run` 是打包检查；`test/pack-install-check.mjs` 更进一步——它只用 manifest 声明会发布的文件，组合出一个一次性的 profile。

`test/cordis-mount.mjs` 是钉住插件**形态**的那个检查：它把包的导出挂载到一个真实的 `Context` 上，同时也会挂载 0.2 之前的形态（调用 `ctx.settings.register` 的那个）并**要求它失败**，这样这个检查就不可能悄悄失去意义。

### 发布

`.github/workflows/publish.yml` 使用 npm 的 **trusted publishing**（OIDC）：这个仓库不存在长期有效的 token，npm 会用包页面上配置的 trusted publisher 来校验 workflow 的短期身份。手动触发该 workflow 即可，只想想看 tarball 就用它的 dry-run 输入。

如果你手动发布，注意两个坑：

- 暂存（staged）版本会**阻塞**同版本号的直接发布，而清除暂存需要 WebAuthn 安全密钥。此时抬高版本号是出路。
- npm registry 可能需要几分钟才让新版本可见。发布报成功但 `npm view` 还看不到，并不等于失败——过一会儿再查。

### 变更记录

#### 0.2.2

仅文档变更，行为未改动。

README 重写为面向**安装和使用插件的人**，而不是面向读源码的人：手机上会收到什么、四步配置、每个设置项的含义、故障排查、卸载。开发者内容移到末尾。

`README.zh.md` 是完整中文翻译，两个文件互相链接。

配置步骤里新增了飞书官方的自定义机器人指南链接，飞书那一侧交由官方文档说明。

#### 0.2.1

真正发布到 npm 的版本。内容与下面描述的 `0.2.0` 完全一致；版本号变动的唯一原因是 `0.2.0` 已在 npm 上暂存，而暂存版本会阻塞同版本号的直接发布，清除暂存又需要 WebAuthn 安全密钥。抬高版本号是不需要安全密钥的那条出路。因此 `0.2.0` 从未发布、也不会发布——请不要把它的缺席理解为撤回。

#### 0.2.0 — 要求 dsh 0.2

**破坏性变更：此版本无法在 dsh 0.1.x 上加载，0.1.1 也无法在 0.2 上加载。** 宿主半原先通过 `ctx.settings.register` 获取配置，该方法在 0.2.0 中被移除；现在改为导出 `Config` schema 并通过 `ctx.settings.update` 写入。

推送消息去掉了包名前缀：首行只有标题。`Send test` 现在与里程碑走同一个组装函数，因此前缀和长度上限对它同样生效。

设置页面按 dsh 的设置设计系统重建：所有开关都是 switch，每次编辑立即生效，且 `Send test` 是唯一的按钮。

#### 0.1.1

首个发布版本：`dsh_beacon` 工具、三个事件钩子、脱敏的设置页面，以及两条 HTTP 路由，基于 dsh `0.1.5-rc.2` 验证。

#### 兼容性

依照 dsh `0.2.0-rc.2` 验证。dsh 是开发者预览版并明确承诺会有破坏性变更，因此请把这理解为「本插件宿主半契约所读取的版本」，而不是对更高版本的兼容性承诺。

## 许可证

MIT
