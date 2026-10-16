# ChatGPT Local Agent Bridge

把 chatgpt.com 网页版（Free 档可用）接入本机 Agent：AI 在对话中输出 ` ```agent ` 指令块，Chrome 扩展捕获后交给本地服务真实执行（文件读写、PowerShell/Git Bash 命令、后台会话），结果自动回填输入框并自动发送，形成"对话即操作电脑"的闭环。

```
你在 chatgpt.com 发任务
→ AI 回复 ```agent {"action":...}``` 指令块
→ content script 检测/去重/解析
→ background (WS, Origin+Token 双因子鉴权)
→ 本地服务：安全策略 → 执行
→ 结果原路返回 → 自动回填 + 自动发送
→ AI 读取真实结果继续 → done 结束
```

## 目录结构

```
├── start.bat                  # 一键前台启动服务
├── scripts/
│   ├── server-loop.bat        # 隐藏自启用的带守护循环启动器
│   └── install-autostart.ps1  # 安装/卸载登录自启（-Remove 卸载）
├── server/                    # 本地 Agent 服务（Node ≥22，依赖仅 ws）
│   ├── config.json            # 端口/根目录/白名单/黑名单/确认开关
│   ├── config.local.json      # 自动生成，含配对 token（勿提交）
│   ├── smoke.mjs              # 无扩展链路自测（需服务已启动）
│   ├── src/…                  # ws-server / policy / fs-tools / engine(vendored)
│   └── test/…                 # node --test 单元与集成测试
├── extension/                 # Chrome MV3 扩展（加载解压即可用）
│   ├── manifest.json
│   ├── adapters/              # 站点适配器：每个 AI 网页聊天一个文件
│   │   ├── chatgpt.js         # chatgpt.com（ProseMirror 输入框）
│   │   ├── chatglm.js         # chatglm.cn 智谱清言（启发式首版，按实测迭代）
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

## 配置（server/config.json）

| 项 | 说明 |
|---|---|
| `allowedRoots` | 文件工具允许的根目录（也是 shell 的 cwd 允许范围） |
| `policy.whitelist` | 白名单命令头（git/node/python…），命中直接执行 |
| `policy.confirmUnknown` | `true`（默认）：白名单外命令弹**页内确认条**，60 秒未确认自动拒绝；`false` 直接拒绝 |
| `policy.defaultAllow` | `true` 时关闭白名单（黑名单仍然生效），不建议 |
| `maxActiveSessions` / `maxOutputBytes` | 后台会话数量与输出轮转上限 |

黑名单硬拒：format X:、shutdown、taskkill、reg、net、Remove-Item、del/rd/rm 等，任何配置下都不放行。

## 安全护栏

- WS 仅监听 127.0.0.1；Origin 必须是 chrome-extension://；配对 token 握手，错误 3 次封禁 60 秒
- 文件操作限定 `allowedRoots`；shell cwd 同样受限（注意：**shell 本身不是沙箱**，白名单只是第一道闸）
- 页内确认条：白名单外命令必须人工批准，显示完整命令预览
- 扩展侧护栏：单任务步数上限（默认 30，popup 可调 10–100）、连续 3 次失败熔断、同一指令重复死循环熔断、120 秒响应超时
- popup 可随时"暂停监听"或关闭"自动发送"（变为填入待手动回车）

## 多站点支持

桥接层与协议与站点无关，`adapters/` 里每个 AI 网页聊天一个适配器（统一接口：`isGenerating / findInput / insertText / send`）。当前支持：

| 站点 | 适配器 | 状态 |
|---|---|---|
| chatgpt.com | `chatgpt.js` | 已实测 |
| chatglm.cn（智谱清言） | `chatglm.js` | 启发式首版，需实测迭代 |

新增站点三步：`manifest.json` 的 `matches` 加域名 → 新建适配器文件（可从 `chatglm.js` 复制启发式实现起步）→ `registry.js` 注册。去重记忆按 `适配器id:hash` 隔离，多站点互不干扰。协议模板各站通用（粘贴同一份 `docs/chat-prompt.md` 即可）。

## 日常使用

- 启动：`start.bat`；关闭：服务终端 Ctrl + C 或关窗口（后台会话进程不受影响，重开后 `session_list` 可找回）
- 登录自启（可选）：管理员不需要；PowerShell 运行 `scripts/install-autostart.ps1` 装到当前用户 Startup（隐藏窗口 + 崩溃自动重启），`-Remove` 卸载
- 扩展图标 popup：连接状态、页面脚本心跳（联调时看它判断断在哪）、暂停/自动发送/新任务重置

## 故障排查

| 现象 | 处理 |
|---|---|
| popup 显示"未连接" | 服务没起（先跑 start.bat）或 token 没配对 |
| 心跳显示"无心跳" | chatgpt.com 标签页没刷新（改扩展代码后必须 F5） |
| AI 不输出 agent 块 | 把协议模板发它，或回复"按 agent 协议执行" |
| `no-agent-block-on-page` 持续 | chatgpt.com 改版：F12 确认 `pre code` 的 class/头部标签，改 `extension/selectors.js` |
| 回填成功但不发送 | popup 心跳应显示 `send-ok · …`；若 `send-failed`，检查发送按钮选择器 |
| 命令被拒绝 | AI 会返回命令名，加进 `policy.whitelist` 重启服务；或走页内确认 |
| 中文乱码 | 保持默认 PowerShell（脚本已强制 UTF-8 + BOM） |

## 开发与测试

```powershell
cd server
npm install
npm test        # 21 个单元/集成测试（含真实 PowerShell 会话）
npm run start   # 启动服务
node smoke.mjs  # 无扩展全链路自测（需服务已启动）
```

改完扩展代码：`chrome://extensions` 重新加载 + chatgpt.com 页面 F5。

## 已知边界

- 交互式终端已支持（node-pty / ConPTY）：`terminal_start` + `session_write`/`session_read`/`session_interrupt`/`session_resize`；终端输入过黑名单检查（不做白名单，注意终端本质不是沙箱）
- 多标签页仲裁：第一个打开的 chatgpt.com 标签自动成为"任务标签"，其他标签左下角显示"此页非任务标签 · 点击接管"，确认条只弹在任务标签
- 回填结果超过约 9–12K 字符时合法截断并附 `nextOffset` 续读指引（`session_read`/`fs_read offsetBytes` 翻页）
- chatgpt.com 前端改版可能使选择器失效（已集中在 `selectors.js`，按故障排查表修）

## 安全须知

本工具把"当前 Windows 用户权限的文件与 shell"暴露给 AI 对话，等于把执行权交给模型输出。请：保持默认白名单 + 页内确认；不要把 `allowedRoots` 开到盘根；token 不要外传；在不可信对话里用 popup 暂停监听。详细威胁模型见上游项目 [chat-local-agent-mcp](https://github.com/AblazeGHR/chat-local-agent-mcp) 的 SECURITY 思路（本项目引擎 vendored 自它，MIT）。
