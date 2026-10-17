# 快速安装提示词（复制给你电脑上的 AI Agent）

> 把下面整段复制给你电脑上的任意编程 Agent（Trae / Cursor / Claude Code / Windsurf 等），它会自动完成安装配置，最后告诉你浏览器里还差哪几步。

```
请帮我安装并配置 ChatGPT Local Agent Bridge（把网页版 AI 对话接入本机执行工具的项目），按以下步骤执行，每步完成后验证再进入下一步：

1. 安装代码：如果 git 可用，执行 git clone https://github.com/Thelittlewinter233/chatgpt-local-agent.git 到 D:\agent-bridge（目录已存在就先问我）；否则下载 https://github.com/Thelittlewinter233/chatgpt-local-agent/archive/refs/heads/main.zip 解压到同一路径。
2. 检查环境：node -v 必须 >= 22。低于 22 就停下来，告诉我去 https://nodejs.org 装 LTS 版，装好后继续。npm 必须可用。
3. 安装依赖：在仓库的 server 目录执行 npm install。如果国内网络超时，先执行 npm config set registry https://registry.npmmirror.com 再重试。
4. 启动服务：在 server 目录后台启动 npm run start（Windows 可用 PowerShell 的 Start-Process 开新窗口，保持窗口存活）。启动后用 node -e "fetch('http://127.0.0.1:9752').catch(()=>{})" 之外的方式验证：读取 server/config.local.json 是否已生成（首次启动自动生成），包含 token 字段即成功。服务日志应显示 ws server listening on ws://127.0.0.1:9752。
5. 把 config.local.json 里的 token 值显示给我，提醒我不要外传。
6. 告诉我剩下的浏览器手动步骤（Agent 无法代替）：
   a. 打开 chrome://extensions（Edge 是 edge://extensions），右上角开启"开发者模式"
   b. 点"加载已解压的扩展程序"，选择仓库里的 extension 文件夹
   c. 点浏览器工具栏的 Agent Bridge 图标，把 token 粘贴进去，点"保存并测试连接"，看到"已连接本地服务"即配对成功
   d. 打开 https://chatgpt.com（或 chatglm.cn / chat.deepseek.com / www.kimi.com / chat.qwen.ai 任一），在对话页按 Alt+P 注入协议，补一句任务发送
7. 等我完成上面浏览器步骤后，给我一条验证任务让我发给 AI："在 tmp 目录创建 hello.txt 内容为 hi，然后读回来确认"。如果 AI 输出了 agent 代码块并自动回填结果，说明全链路通了。

注意事项：
- 全程不要修改 server/config.json 里的安全策略（白名单、黑名单、allowedRoots）。
- 服务用完可以关：在服务窗口按 Ctrl+C；下次用仓库根目录的 start.bat 一键启动。
- 如果 npm install 报 node-pty 编译错误，告诉我完整报错。
```

## 提示词帮你做完后，你只剩三步

| 步骤 | 操作 | 成功标志 |
|---|---|---|
| 装扩展 | `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension` 文件夹 | 工具栏出现 Agent Bridge 图标 |
| 配对 | 点图标 → 粘贴 token → 保存并测试连接 | 显示"已连接本地服务"、角标绿 ✓ |
| 注入协议 | 打开任一支持的 AI 站点，按 **Alt+P** | 输入框出现协议文本，补任务发送 |

验证任务：`在 tmp 目录创建 hello.txt 内容为 hi，然后读回来确认`——看到 AI 输出 agent 代码块、自动回填结果、最后报 done，即全链路打通。
