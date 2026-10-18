# 项目交接文档（HANDOVER）

> 交接对象：下一个继续开发的 AI 会话或人类开发者。
> 阅读顺序：本文档 → `README.md` → 关键源码。改代码前必读「开发守则」。

## 1. 项目是什么

**ChatGPT Local Agent Bridge**：把网页版 AI 对话（ChatGPT Free / GLM / DeepSeek / Kimi / Qwen 等）接入本机执行能力。AI 在对话中输出 ` ```agent ` JSON 指令块 → 浏览器扩展捕获 → 经 WebSocket 交给本地 Node 服务真实执行（文件读写、命令、交互终端）→ 结果以 ` ```agent-result ` 块自动回填并自动发送 → AI 读取真实结果继续，直到输出 `done`。

- 仓库：https://github.com/Thelittlewinter233/chatgpt-local-agent（git 推送必须走本地 7890 代理，直连 GitHub 443 超时）
- 技术栈：Chrome MV3 扩展（原生 JS）+ Node ≥22 服务端（仅依赖 ws + node-pty，引擎 vendored 自 chat-local-agent-mcp，MIT）
- 端口：`ws://127.0.0.1:9752`，Origin + token 双因子鉴权

```
网页 AI 对话 → ```agent 块 → content.js（检测/去重/站点适配器）→ background.js（WS 状态机）
→ 服务端 dispatch（安全策略分流）→ 执行 → result 帧 → 回填+自动发送 → 循环至 done
```

## 2. 目录结构与关键文件

```
├── start.bat                    # 一键启动服务
├── scripts/install-autostart.ps1
├── server/
│   ├── config.json              # 端口/allowedRoots/白名单/黑名单/policy（公开仓库默认值应为保守）
│   ├── config.local.json        # 自动生成，含配对 token，勿提交
│   ├── smoke.mjs                # 无扩展全链路自测（自适配 policy 初始值并恢复）
│   ├── src/index.mjs            # 入口：route/dispatch（越界分流矩阵）/setPolicy 热切换/审计
│   ├── src/policy.mjs           # checkPathResolved（symlink 解包）/classifyCommand/黑名单/checkTerminalInput
│   ├── src/fs-tools.mjs         # 13 个 fs 工具（统一用 checkPathResolved）
│   ├── src/ws-server.mjs        # WS：鉴权/confirm waiter/重放缓存/activeWs
│   ├── src/engine/              # vendored：sessions/session-worker/common（MIT）
│   └── test/                    # node --test（29 个）
├── extension/
│   ├── manifest.json / manifest.firefox.json   # Firefox 版需重命名为 manifest.json 加载
│   ├── sites.js                 # 站点入口清单（域名自适应探测用）
│   ├── adapters/                # heuristic.js 工厂 + chatgpt/chatglm/deepseek/kimi/doubao/qwen/generic
│   ├── content.js               # 站点无关主循环：块检测/去重/回填/发送/确认条三态/协议注入
│   ├── background.js            # WS 状态机/重连/重放/多标签仲裁/域名自适应/角标
│   ├── popup/                   # 配对/暂停/自动发送/完全批准开关/域名自适应 UI
│   └── assets/chat-prompt.txt   # Alt+P 注入的协议正文
└── docs/                        # chat-prompt.md / custom-instructions.md / install-prompt.md / 本文档
```

## 3. 服务端 action 全表

| 类别 | action | 要点 |
|---|---|---|
| 元信息 | computer_info | 平台/shell/limits（waitMsMax 60000、commandMaxLength 16000）/notes；任务第一步 |
| 文件读 | fs_read / fs_list / fs_tree / fs_search / fs_glob / fs_grep / fs_info | 越界**硬拒**（任何模式）；fs_read 单页 256KB，nextOffset 续读；fs_grep 正则搜内容返回 {file,line,text}；fs_glob 支持 `**` |
| 文件写 | fs_write / fs_edit / fs_edit_multi / fs_move / fs_mkdir / fs_delete | 确认模式越界弹确认条，完全批准直通；fs_edit 精确替换（expectedCount/expectedSha256）；fs_edit_multi ≤20 处原子批量；fs_delete 仅删单文件 |
| 命令 | shell | 白名单头部 + 黑名单硬拒；waitMs≤60000，超时返回 running+sessionId 不杀进程；mode=detach |
| 终端 | terminal_start + session_write/read/list/interrupt/close/resize | PTY 持久终端；冷启动约 2 秒；session_read 用 nextOffset 游标；输入只过黑名单 |

## 4. 权限模型（当前最终形态）

| 维度 | 黑名单 | 确认模式（默认） | 完全批准模式（allowOutOfRoots） |
|---|---|---|---|
| 危险命令（format/shutdown/taskkill/reg/del 等） | **硬拒** | 硬拒 | 硬拒（唯一不可逾越的线） |
| 根内文件/命令 | — | 直接执行 | 直接执行 |
| 白名单外命令 | — | 弹确认条 | 直接执行 |
| 越界 fs 写类（write/edit/edit_multi/move/mkdir/delete） | — | 弹确认条（显示**解包后真实路径**） | 直接执行 |
| 越界 fs 读类 | — | **硬拒** | 直接执行 |
| shell/terminal 越界 cwd | — | 弹确认条 | 直接执行 |

- 确认条三态：**批准**=执行+回填结果；**拒绝**=不执行+回填 denied；**× 关闭**=不执行+不回复（AI 侧 300s 超时兜底）
- 模式切换只能由用户在 popup 操作（set-policy WS 帧），AI 无法自行提权；切换会持久化写回 config.json
- 所有 mutating 操作和所有 bypass 操作落审计日志 `server/runtime/audit/*.jsonl`
- 路径检查统一走 `checkPathResolved`（symlink 逐级解包+missing 回退+real 复检），bypass 时也解包并返回真实路径——确认条显示的路径必须与实际操作一致

## 5. 站点适配器与域名自适应

- 适配器 = 4 个方法（matches/isGenerating/findInput/insertText/send），insertText/send 必须自带验证（回填用去空白比对、发送以输入框清空为准）
- 新站点优先用 `heuristic.js` 工厂（声明 inputSelectors/sendSelectors/stopPattern 即可）；特殊编辑器照 chatgpt.js 手写
- **代码块检测是按站点定制的**：chatgpt=`pre>code.language-agent`，deepseek=`pre>span`，qwen=`pre>div.qwen-markdown-code-body`（无 code 元素）——content.js `codeBodyIfAgent` 用候选式检测（code → `[class*="code-body"]` → span），`header==='agent'` 只对 CODE 元素生效，span/div 主体必须以 `{"action"` 开头
- **域名自适应**（防站点改名换域）：sites.js 入口清单 + `chrome.scripting.registerContentScripts` 动态注入（与 manifest 静态 matches 自动去重）+ popup「检测站点域名跳转」（后台静默开标签抓最终 URL）+ 手动添加域名（popup 输入框，permissions.request 在 popup 手势内调用）
- 已适配：chatgpt.com、chatglm.cn、chat.deepseek.com、kimi.com/moonshot.cn、doubao.com、**chat.qwen.ai**（DOM 已实测）、qianwen.com（千问国内版）、tongyi.aliyun.com；豆包用户已弃用

## 6. 参数速查（v4.0 放宽后）

| 参数 | 值 | 位置 |
|---|---|---|
| 命令总响应超时（扩展侧） | 300s | background.js sendCmd |
| shell 命令长度 | 16000 字符 | policy.mjs |
| shell/session waitMs 上限 | 60s | index.mjs + session-worker（两处必须同步改） |
| 结果回填截断 | 整体 16000 / 单字段 12000 | content.js（nextOffset 续读兜底） |
| fs_read 单页 | 256KB | fs-tools.mjs |
| 单任务步数 | 默认 30，popup 可调 10-100 | content.js opts |
| 确认重放 | 相同块仅重放 1 次、仅限不同 DOM 元素 | content.js lastResults |
| 冷却窗口 | 回填发送后 5s | content.js cooldownUntil |

## 7. 开发历程（里程碑）

| 阶段 | 内容 |
|---|---|
| v1 | MVP：协议设计、MV3 扩展、WS 服务端、chatgpt 闭环 |
| v1.1-1.5 | 白名单外确认、start.bat/自启、PTY 交互终端、多标签仲裁、大结果分段 |
| v2.0-2.2 | 适配器架构（heuristic 工厂）+ GLM/DeepSeek/Kimi/豆包 + Alt+P 一键注入协议 |
| v2.3 | 安全加固轮：symlink 防护、审计日志、角标、重放 10min 过期、token 轮换、health.html |
| v2.4 | Firefox/Edge 适配（event page、Xray var 挂载、IIFE-return 适配器模式） |
| v2.5-2.9 | 实战修复轮：确认条不弹（stale leader/activeWs）、重复发送（单动作+轮询清空）、半截块死循环、重放设计缺陷（DOM 引用区分状态残留）、leader 胶囊前置 |
| v3.0 | 完全批准模式（popup 开关 + set-policy 热切换） |
| v3.1 | fs_edit_multi / fs_glob / fs_grep（对标 CodeBuddy 工具面） |
| v3.2-3.4 | Qwen 接入：qianwen.com 域名跳转、chat.qwen.ai（DOM 实测）、无 code 元素的代码块检测 |
| v3.3 | 域名自适应根治（动态脚本注册 + 跳转探测 + 手动加域名） |
| v3.5 | 安装教程细化 + 快速安装提示词（docs/install-prompt.md，给编程 Agent 用的自包含安装提示词） |
| v3.6 | Firefox web-ext lint 修复：`browser_specific_overrides`→`browser_specific_settings`、data_collection_permissions、最低版本 140 |
| v3.7-4.1 | 完全批准模式三轮扩展（越界读→白名单外命令→shell/terminal cwd）+ 确认条三态 + 权限放宽（300s/16000/60s/16000） |
| v4.2 | 越界权限全面审计：terminal_start 补 realpath、确认条显示解包真实路径、confirmUnknown=false 漏网、bypass 全审计 |
| v4.3 | GLM 搜索误触定性为平台行为，协议禁令已按用户要求撤销（e1e9ec2），用户手动关 GLM 搜索开关 |

## 8. 开发守则（血泪教训浓缩，违反必踩坑）

1. **代码零注释**——用户硬性要求，任何语言注释都不写
2. **轮询逻辑必须区分「状态残留」与「新事件」**：用 DOM 元素引用（lastResults 缓存 el）判断，禁止"页面上有这个块"就当"刚发生"
3. **解析失败的半截 JSON 块**（流式截断，`{` 开头无 `}` 结尾）：markSeen 后静默跳过，所有 invalid/denied/error 响应统一 cacheResult 限次
4. **自动发送**：每轮只做一个动作（有按钮点按钮，无按钮才回车），发送后轮询最长 3s 等输入框清空，未清空才下一轮
5. **确认条跨 WS 重连**：发给 activeWs（当前活跃连接），不是命令到达时的连接
6. **越界分流矩阵要整体审计**（action × 检查点 × 模式 × symlink 解包）：每次加新的资源维度必须全矩阵过一遍；bypassRoots 必须透传到每一层检查函数（漏传 = 确认后仍拒绝的死循环）
7. **新站点三步走**：浏览器实测真实域名+重定向链 → 实测输入框/发送按钮/代码块的 DOM 结构拿一手选择器 → 改完跑 web-ext lint（Firefox manifest 键名错误曾潜伏 4 天）
8. **PowerShell 会截断嵌套双引号**：`node -e "console.log(\"x\")"` 直接炸，长脚本用 fs_write 写临时文件再执行
9. **smoke.mjs 会改持久化 policy**：开头读初始值、强制确认模式作前提、结尾必须恢复用户原值
10. **测试前必查端口占用**：用户自己的服务常在跑（EADDRINUSE），`netstat -ano | findstr 9752` 找 PID 杀掉
11. **custom-instructions.md 第 2 栏 ≤1500 字符**（平台上限），加内容必须同步压缩
12. **平台内置工具会被模型自主误触**（GPT 的 Code Interpreter、GLM 的联网搜索）：属平台行为非项目 bug，处理方式是协议禁令 + 用户手动关开关

## 9. 测试与调试

```powershell
cd server
npm install          # 国内慢可先 npm config set registry https://registry.npmmirror.com
npm test             # 29 个单测/集成（含真实 PowerShell 会话与 PTY）
npm run start        # 起服务（成功标志：ws server listening on ws://127.0.0.1:9752）
node smoke.mjs       # 无扩展全链路自测（需服务已启动；自适配并恢复 policy）
```

- 改扩展代码：`chrome://extensions` 重载 + 目标站点 F5（两者都必须）
- 改 Firefox manifest：临时目录复制 extension、manifest.firefox.json 改名 manifest.json、`npx web-ext lint`（当前 0 错误 0 警告基线）
- 页面侧诊断：popup 心跳（ab_dbg）stage 对照——`no-adapter-for-this-site`（域名没注册）、`no-agent-block-on-page`（代码块没识别）、`fill-failed`（回填失败）、`send-failed`（发送失败）
- F12 控制台找 `[AgentBridge] content-script-active <adapter>@<host>` 确认注入成功
- push 失败先重试一次（代理偶发 SSL handshake 抖动），再失败提醒用户开代理

## 10. 当前状态与待办

- 主分支与 origin/main 同步（最新 `e1e9ec2`）
- `server/config.json` 有用户本地改动（白名单扩充、allowOutOfRoots:true）**不提交**——公开仓库默认值应保持保守（false）
- `lab05/` 是用户课程作业目录，未跟踪，不要动
- 已知边界：confirmUnknown=false + 完全批准模式 = 白名单完全失效（仅黑名单），这是语义设计而非 bug
- V2 候选（用户未拍板）：自动包装首条消息（拦截各站发送路径，高风险）
- 豆包适配器保留但用户不再使用/未实测

## 11. 给下一个会话的最短上手路径

1. 读本文档和 README
2. `cd server && npm test && npm run start`，另开终端 `node smoke.mjs`——全绿说明环境正常
3. 用户的 GLM/Qwen/DeepSeek/Kimi/ChatGPT 全链路都已实测通过；新需求大概率是：新站点适配（守则 7）、新工具（fs-tools + index.mjs route + 协议三文件 + smoke 四件套）、或又一轮实战 bug（守则 2-6）
4. 改完必跑 `npm test` + smoke +（改了扩展）重载扩展；提交信息英文、推 origin/main
