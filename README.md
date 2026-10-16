# ChatGPT Local Agent Bridge

把 chatgpt.com 网页版（Free 档可用）接入本机 Agent：AI 在对话中输出 ` ```agent ` 指令块，Chrome 扩展捕获后交给本地服务真实执行（文件读写、PowerShell/Git Bash 命令、持久交互终端、后台会话），结果自动回填输入框并自动发送，形成"对话即操作电脑"的闭环。同时支持智谱清言、DeepSeek、Kimi、豆包等多个网页 AI 站点。

```
你在网页 AI 对话里发任务
→ AI 回复 ```agent {"action":...}``` 指令块
→ content script 检测/去重/解析（站点适配器驱动）
→ background (WS, Origin+Token 双因子鉴权)
→ 本地服务：安全策略 → 执行
→ 结果沿原路返回 → 自动回填 + 自动发送
→ AI 读取真实结果继续 → done 结束
```

## 目录结构

```
├── start.bat                  # 一键前台启动服务
├── scripts/
│   ├── server-loop.bat        # 隐藏自启用的带守护循环启动器
│   └── install-autostart.ps1  # 安装/卸载登录自启（-Remove 卸载）
├── server/                    # 本地 Agent 服务（Node ≥22，依赖 ws + node-pty）
│   ├── config.json            # 端口/根目录/白名单/黑名单/确认开关
│   ├── config.local.json      # 自动生成，含配对 token（勿提交）
│   ├── smoke.mjs              # 无扩展链路自测（需服务已启动）
│   ├── src/…                  # ws-server / policy / fs-tools / engine(vendored)
│   └── test/…                 # node --test 单元与集成测试
├── extension/                 # Chrome MV3 扩展（加载解压即可用）
│   ├── manifest.json
│   ├── adapters/              # 站点适配器：每个 AI 网页聊天一个文件
│   │   ├── heuristic.js       # 共享启发式工厂（textarea/contenteditable + 按钮候选 + 回车兜底）
│   │   ├── chatgpt.js         # chatgpt.com（ProseMirror 输入框，已实测）
│   │   ├── chatglm.js         # chatglm.cn 智谱清言（已实测）
│   │   ├── deepseek.js        # chat.deepseek.com（启发式首版）
│   │   ├── kimi.js            # kimi.com / kimi.moonshot.cn（启发式首版）
│   │   ├── doubao.js          # doubao.com 豆包（启发式首版）
│   │   └── registry.js        # 按 location.hostname 选择适配器
│   ├── content.js             # 站点无关主循环：检测/去重/回填/发送/确认条
│   ├── background.js          # WS 状态机/重连/结果重放/多标签仲裁
│   └── popup/                 # 配对 Token、暂停、自动发送、心跳诊断
└── docs/
    ├── chat-prompt.md         # 协议模板完整版（新会话首条粘贴）
    └── custom-instructions.md # 自定义指令精简版（长期生效）
```

## 快速开始

1. **启动服务**：双击 `start.bat`（或 `cd server && npm run start`）。看到 `ws server listening on ws://127.0.0.1:9752` 即成功，token 已写入 `server/config.local.json`
2. **装扩展**：Chrome 进 `chrome://extensions` → 开发者模式 → 加载解压缩的扩展程序 → 选 `extension` 文件夹
3. **配对**：点扩展图标 → 粘贴 `config.local.json` 里的 `token` → 保存并测试连接 → 显示"已连接本地服务"
4. **给 AI 协议**：新会话粘贴 `docs/chat-prompt.md` 分割线内内容（或按其说明配好自定义指令长期生效）
5. **下任务**：如"在 tmp 下创建 hello.txt 内容为 hi，然后读回来确认"

## 详细使用指南

### 5.1 一次完整任务的生命周期

以"在 tmp 下创建 test.txt 写入 1-5 的平方，再读回来统计行数"为例，完整流程是：

| 步骤 | 发生什么 | 你能看到什么 |
|---|---|---|
| 1 | 你在网页 AI 里输入任务 | — |
| 2 | AI 输出第一个指令块（通常是 `computer_info` 或 `fs_write`） | 页面出现带 `agent` 标签的代码块 |
| 3 | 扩展检测到块（等流式结束 + 稳定 600ms） | 右下角 toast"执行 fs_write …"，popup 心跳变 `agent-block-detected` |
| 4 | 指令经 WS 到本地服务，策略校验后执行 | popup 心跳 `cmd-done`；白名单外命令弹**页内确认条** |
| 5 | 结果自动回填为 ` ```agent-result ` 块并自动发送 | 输入框瞬间出现结果文本后被清空 |
| 6 | AI 读到真实结果，输出下一个指令块 | 循环 2-5，popup 进度 `n/30 步` |
| 7 | 任务完成，AI 输出 `done` 块 | toast"任务完成，计数已重置" |

### 5.2 日常使用

- **新会话免粘贴**：在任意支持的 AI 网页里按 **Alt+P**，协议自动填入输入框（或点扩展 popup 的"注入协议到任务标签"）；补一句你的任务后回车即可。协议文本内置在扩展的 `extension/assets/chat-prompt.txt`，想改内容直接编辑该文件后重载扩展
- **启动**：`start.bat`；关闭：服务终端 Ctrl + C 或关窗口（后台会话进程不受影响，重开后 `session_list` 可找回）
- **登录自启**（可选）：PowerShell 运行 `scripts/install-autostart.ps1`（隐藏窗口 + 崩溃自动重启），`-Remove` 卸载
- **多任务连发**：任务正常结束时 AI 会输出 `done`，计数自动清零，同会话可直接下下一个任务；只有步数耗尽/熔断时才需要点 popup 的"新任务"
- **急刹车**：popup"暂停监听"立即停；关闭"自动发送"变为填入待你手动回车
- **多标签页**：第一个打开的 AI 网页标签自动成为"任务标签"，其他标签左下角显示"点击接管"；确认条只弹在任务标签

### 5.3 协议一览

AI 只需要会一件事：输出如下代码块，然后停下等结果。

```
​```agent
{"action":"shell","args":{"command":"node -v","waitMs":8000}}
​```
```

回填结果形如：

```
​```agent-result
{"for":"a1b2c3d4","ok":true,"data":{"exitCode":0,"output":"v24.20.0"}}
​```​
```

全部动作见 [docs/chat-prompt.md](docs/chat-prompt.md) 的工具表：文件读写/精确编辑/目录树/文件名搜索、一次性 shell（wait/detach）、持久交互终端（`terminal_start` + `session_write`/`session_read`/`session_interrupt`/`session_resize`）。输出被截断时结果自带 `hint` 和 `nextOffset`，AI 据此分段续读。

### 5.4 典型场景示例

| 场景 | 示例任务 | 用到的能力 |
|---|---|---|
| 文件批处理 | "把 docs 下所有 .md 的标题提取到 index.md" | fs_list + fs_read + fs_write |
| 代码项目辅助 | "读 server/src/policy.mjs，把黑名单正则加注释说明并跑测试" | fs_read + fs_edit + shell(npm test) |
| 终端交互任务 | "开一个 python 交互终端，定义函数算斐波那契，调用它验证" | terminal_start + session_write/read |
| 长任务后台跑 | "后台跑 npm install，好了告诉我" | shell detach + session_read 轮询 |
| 跨站点对比 | 同一个任务分别发给 GPT 和 GLM，比谁干得好 | 多站点适配器 |

### 5.5 各站点使用注意

- 协议模板通用：任何站点新会话粘贴同一份 [docs/chat-prompt.md](docs/chat-prompt.md)，或直接 Alt+P 注入
- 每个站点的去重记忆独立，互不干扰；但**步数计数全局共享**——换站点连跑大任务时留意 popup 进度
- "启发式首版"的站点（DeepSeek/Kimi/豆包）如回填或发送不灵，按[故障排查](#故障排查)抓 DOM 信息反馈迭代

### 5.6 进阶：用站点自带的"智能体"彻底免注入（零代码替代方案）

部分站点支持自定义智能体/助手（系统提示词内置协议），配好后每次直接开这个智能体，连 Alt+P 都不用按：

| 站点 | 做法 |
|---|---|
| 智谱清言 | GLMs 智能体中心创建自定义智能体，把 `docs/chat-prompt.md` 正文贴进"系统提示词" |
| Kimi | 创建"Kimi+"助手，提示词同上 |
| 豆包 | 创建 Bot，人设与回复约束里贴协议 |
| DeepSeek C 端 | 无全局自定义指令，建议每次用 Alt+P 注入 |
| chatgpt.com（Free） | 创建 GPT 需 Plus；Free 用 Alt+P 注入，或配"自定义指令"（见 docs/custom-instructions.md） |

注意：智能体的系统提示词里协议遵循效果因站而异，首次使用先用自检任务验证一轮。

## 配置详解（server/config.json）

| 项 | 说明 |
|---|---|
| `port` | WS 服务端口，默认 9752 |
| `allowedRoots` | 文件工具允许的根目录（也是 shell 的 cwd 允许范围） |
| `policy.whitelist` | 白名单命令头（git/node/python…），命中直接执行 |
| `policy.confirmUnknown` | `true`（默认）：白名单外命令弹**页内确认条**（显示完整命令，60 秒倒计时）；`false` 直接拒绝 |
| `policy.defaultAllow` | `true` 时关闭白名单（黑名单仍然生效），不建议 |
| `policy.blacklist`（内置） | format X:、shutdown、taskkill、reg、net、Remove-Item、del/rd/rm 等，任何配置下硬拒 |
| `shells` | 可用的 shell 及路径（powershell / powershell7 / git-bash） |
| `maxActiveSessions` / `maxOutputBytes` | 后台会话数量与输出轮转上限 |

## 安全护栏

- WS 仅监听 127.0.0.1；Origin 必须是 chrome-extension://；配对 token 握手，错误 3 次封禁 60 秒
- 文件操作限定 `allowedRoots`；shell cwd 同样受限（注意：**shell 本身不是沙箱**，白名单只是第一道闸）
- 页内确认条：白名单外命令必须人工批准，显示完整命令预览
- 扩展侧护栏：单任务步数上限（默认 30，popup 可调 10–100）、连续 3 次失败熔断、同一指令重复死循环熔断、120 秒响应超时
- popup 可随时"暂停监听"或关闭"自动发送"（变为填入待手动回车）
- 去重记忆按 `站点:hash` 隔离，防止跨站点误吞；同一指令连现自动熔断

## 如何添加新的网页 Chat 适配器

主循环（content.js）与站点解耦，接入一个新站点只需要实现一个"适配器对象"。适配器通过 `window.__abXxxAdapter` 全局变量暴露，由 `registry.js` 按 `location.hostname` 选择。

### 适配器接口（4 个方法）

| 方法 | 签名 | 职责 | 返回 |
|---|---|---|---|
| `matches` | `host => bool` | 判断当前页面是否归它管 | true/false |
| `isGenerating` | `() => bool` | AI 是否正在流式输出（检测"停止"按钮特征） | true/false |
| `findInput` | `() => Element\|null` | 找到对话输入框元素 | 元素或 null |
| `insertText` | `async text => bool` | 把文本写入输入框并**验证成功** | true/false |
| `send` | `async () => bool` | 触发发送并**以输入框被清空为成功标准** | true/false |

约束：`insertText`/`send` 必须自带验证（不能点了就算成功）；回填文本包含 ` ``` ` 围栏，验证请用去空白比对；每次查询元素现查现用，不要缓存引用（SPA 会重渲染）。

### 方法一：启发式工厂（推荐起步，5 分钟）

`heuristic.js` 暴露 `__abMakeHeuristicAdapter(opts)` 工厂，内置"粘贴 → execCommand → 原生 setter"三级回填和"按钮点击 → 回车"双路发送。新站点文件只需声明选择器候选：

```js
window.__abYoursiteAdapter = window.__abMakeHeuristicAdapter({
  id: 'yoursite',
  matches: host => host === 'yoursite.com' || host.endsWith('.yoursite.com'),
  inputSelectors: [
    '#chat-input',              // 站点特异 id（有就填，没有删掉）
    'textarea',                 // 兜底：页面最后一个可见 textarea
    '[contenteditable="true"]'  // 兜底：最后一个可见富文本框
  ],
  sendSelectors: [
    'button[data-testid*="send"]',
    'button[aria-label*="发送"]',
    'button[class*="send" i]',
    'button[type="submit"]'
  ],
  stopPattern: /停止生成|stop|停止/i
});
```

然后在两处注册：`registry.js` 的列表加一行；`manifest.json` 的 `matches` 加 `"https://yoursite.com/*"`。重载扩展 + 刷新页面即可实测。

### 方法二：手写适配器（站点太特殊时）

当站点输入框是特殊编辑器（如 ProseMirror/CodeMirror）或发送逻辑怪异时，照 `adapters/chatgpt.js` 手写完整实现——把 `insertText`/`send` 的内部逻辑换成站点专属操作，接口不变。chatgpt 适配器里的关键技巧（ProseMirror 用 DataTransfer+paste 事件注入、发送以清空为准、回车 keydown 兜底）可直接参考。

### 调试与迭代

1. 打开目标站点，F12 控制台依次执行探测：
   ```js
   document.querySelectorAll('textarea, [contenteditable="true"]').length
   document.querySelectorAll('pre code').length
   document.querySelector('pre code')?.className
   ```
2. 点扩展图标看**页面脚本心跳**，对照下表定位：
   | 心跳 stage | 含义 | 处理 |
   |---|---|---|
   | `no-adapter-for-this-site` | 域名没注册 | 检查 manifest matches 与 registry |
   | `no-agent-block-on-page` | 代码块没识别到 | 检查渲染器的 code class/头部标签，调 `codeBodyIfAgent` |
   | `fill-failed` | 输入框没找到或写入失败 | 按探测结果调 `findInput`/`insertText` |
   | `send-failed` | 按钮和回车都没生效 | 抓发送按钮真实特征，调 `sendSelectors` |
3. 改完：`chrome://extensions` 重载扩展 + 目标页 F5

## 故障排查

| 现象 | 处理 |
|---|---|
| popup 显示"未连接" | 服务没起（先跑 start.bat）或 token 没配对 |
| 心跳显示"无心跳" | 目标站点标签页没刷新（改扩展代码后必须 F5） |
| AI 不输出 agent 块 | 把协议模板发它，或回复"按 agent 协议执行" |
| `no-agent-block-on-page` 持续 | 站点改版：按上文调试清单抓 DOM，改对应适配器 |
| 回填成功但不发送 | popup 心跳应显示 `send-ok · …`；若 `send-failed`，抓发送按钮特征 |
| 命令被拒绝 | AI 会返回命令名，加进 `policy.whitelist` 重启服务；或走页内确认 |
| 中文乱码 | 保持默认 PowerShell（脚本已强制 UTF-8 + BOM） |

## 开发与测试

```powershell
cd server
npm install
npm test        # 21 个单元/集成测试（含真实 PowerShell 会话与 PTY 交互终端）
npm run start   # 启动服务
node smoke.mjs  # 无扩展全链路自测（需服务已启动）
```

改完扩展代码：`chrome://extensions` 重载扩展 + 目标站点页 F5。

## 安全须知

本工具把"当前 Windows 用户权限的文件与 shell"暴露给 AI 对话，等于把执行权交给模型输出。请：保持默认白名单 + 页内确认；不要把 `allowedRoots` 开到盘根；token 不要外传；在不可信对话里用 popup 暂停监听。详细威胁模型见上游项目 [chat-local-agent-mcp](https://github.com/AblazeGHR/chat-local-agent-mcp) 的 SECURITY 思路（本项目引擎 vendored 自它，MIT）。
