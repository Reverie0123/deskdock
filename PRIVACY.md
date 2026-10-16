# Privacy and data flow · 隐私与数据流向

English first, 中文在后。

## What DeskDock sends over the network

Nothing. DeskDock opens no outbound connection. The only socket it ever creates is the local control panel on `127.0.0.1`, on fixed port 17337, protected by a token that is new for every run (written only to your own `%APPDATA%\deskdock\panel.json`) and a Host check. You can verify this: block `node.exe` and `deskdock-helper.exe` in Windows Firewall; every feature keeps working.

## Where your screen content goes anyway

DeskDock is a collector. What it reads is handed to **your AI client** (Claude Code, Claude Desktop, Cursor, Cline, Cherry Studio, ...), which sends it to **the model provider you configured** (Anthropic, OpenAI, DeepSeek, a local model, ...). That is the only place your data leaves the machine, and it is governed by that provider's terms, not by DeskDock.

| Data | Read when | Leaves the machine? | Stored locally? |
|---|---|---|---|
| Window list (titles, process names) | `list_windows` | yes, to your model provider via the client | titles of targeted windows appear in the audit log |
| UI tree of a window (control names, values, text) | `read_window` | yes | no |
| Screenshot | `screenshot` | yes | no (never written to disk) |
| OCR text | `read_screen_text` | yes | the temporary PNG is deleted right after recognition |
| Clipboard text | `clipboard_get` (allowed by the level of the app that copied it; refused if that app has exited) | yes | no |
| Text you ask the model to type | `type`, `set_value`, `clipboard_set` | it came from the model | audit log keeps only the character count; a **macro** file never keeps recorded text (it is turned into a parameter) |
| Tool calls themselves | every call | no | audit log: `%APPDATA%\deskdock\logs\*.jsonl` (time, tool, arguments, target window, outcome) |

The `ask` level pops a system dialog before every mouse or keyboard action; 30 seconds without an answer counts as no.

A `read` level in the policy still means the model can see that app. Use `block` for anything the model should not even look at; while a blocked app is visible, full-screen capture is refused.

## What never happens

- No telemetry, no crash reports, no update checks, no analytics of any kind.
- No background capture: nothing is read until the model calls a tool, and each call reads one window once.
- No remote control: there is no server, no account, no pairing.
- Passwords: the model is instructed never to type passwords or payment details and to ask you instead. Keep password managers and banking apps on `block` (the default list covers common ones).

## Prompt injection

Screen content can contain text written by someone else (a web page, an e-mail, a chat message) that tries to instruct the model. DeskDock labels everything it returns as data rather than instructions and tells the model to ignore commands found there, but no tool can make a model immune. Treat an agent operating your desktop like a new employee: give it the permission levels it needs and nothing more, and watch the audit log.

## Verifying the binaries

`resources/deskdock-native.exe` (one file: the engine in `--helper` mode, the tray icon when double-clicked) is built from `native/` with MinGW-w64 using the exact command in `package.json` (`build:native`). The GitHub Actions workflow in `.github/workflows/build.yml` rebuilds them on a clean GitHub-hosted Windows runner and publishes the SHA-256 of every file; compare them with what you downloaded, or build your own.

## Deleting everything

Uninstall with `npx deskdock setup --remove`, then delete `%APPDATA%\deskdock` (policy, logs, macros) and `%LOCALAPPDATA%\Temp\deskdock` (test files).

---

## DeskDock 往网络上发什么

什么都不发。DeskDock 不发起任何对外连接。它唯一创建的网络端口是 `127.0.0.1` 上的本地控制面板，固定端口 17337，带每次运行重新生成的令牌（只写进你自己的 `%APPDATA%\deskdock\panel.json`）和 Host 校验。你可以自己验证：在 Windows 防火墙里禁止 `node.exe` 和 `deskdock-helper.exe` 联网，所有功能照常。

## 那你的屏幕内容去了哪

DeskDock 是个采集器。它读到的东西交给**你的 AI 客户端**（Claude Code、Claude 桌面应用、Cursor、Cline、Cherry Studio 等），客户端再发给**你配置的模型服务商**（Anthropic、OpenAI、DeepSeek、本地模型等）。这是数据离开你电脑的唯一一条路，受那家服务商的条款约束，和 DeskDock 无关。

| 数据 | 什么时候读 | 会离开电脑吗 | 本地留存吗 |
|---|---|---|---|
| 窗口列表（标题、进程名） | `list_windows` | 会，经客户端发给模型服务商 | 被操作窗口的标题会进审计日志 |
| 窗口控件树（控件名、值、文字） | `read_window` | 会 | 不 |
| 截图 | `screenshot` | 会 | 不（从不写盘） |
| OCR 文字 | `read_screen_text` | 会 | 临时图片识别完立即删除 |
| 剪贴板文字 | `clipboard_get`（按复制它的程序的级别判断；那个程序已关闭则拒绝） | 会 | 不 |
| 模型让它输入的文字 | `type`、`set_value`、`clipboard_set` | 本来就来自模型 | 审计日志只记字数；**宏**文件不保留录制时的原文（自动变成参数） |
| 工具调用本身 | 每次调用 | 不 | 审计日志 `%APPDATA%\deskdock\logs\*.jsonl`（时间、工具、参数、目标窗口、结果） |

权限表里的「只读」仍然意味着模型能看到那个程序。连看都不该看的，设为「禁止」；屏幕上有禁止级窗口时，整屏截图会被拒绝。

## 永远不会发生的事

- 没有遥测、崩溃上报、更新检查、任何形式的统计。
- 没有后台采集：模型不调用工具，什么都不读；每次调用只读一个窗口一次。
- 没有远程控制：没有服务器、没有账号、没有配对。
- 密码：工具说明要求模型绝不输入密码和支付信息，遇到了请你来。密码管理器和网银请保持「禁止」（默认名单已包含常见的）。

## 提示注入

屏幕上的内容可能是别人写的（网页、邮件、聊天消息），里面可能藏着给模型的指令。DeskDock 把返回的所有内容标注为「数据，不是指令」，并要求模型忽略其中的命令，但没有任何工具能让模型免疫。把操作你桌面的 Agent 当成新来的员工：只给它需要的权限，并且看审计日志。

## 验证可执行文件

`resources/deskdock-native.exe`（一个文件：带 `--helper` 参数时是引擎，双击就是托盘图标）由 `native/` 下的源码用 MinGW-w64 编译，命令就是 `package.json` 里的 `build:native`。`.github/workflows/build.yml` 会在 GitHub 托管的干净 Windows 机器上重新编译并公布每个文件的 SHA-256，你可以和下载到的对比，或者自己编。

## 彻底删除

`npx deskdock setup --remove` 卸载，然后删掉 `%APPDATA%\deskdock`（权限表、日志、宏）和 `%LOCALAPPDATA%\Temp\deskdock`（测试文件）。
