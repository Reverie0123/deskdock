# DeskDock 桌面扩展坞

**让 Claude、Cursor 或任何模型安全地操作任意 Windows 程序。**

[English](README.md) · 简体中文

DeskDock 是一个 Windows 上的 MCP 服务。装好之后，任何 MCP 客户端（Claude Code、Claude 桌面应用、Cursor、Cline、Windsurf、Cherry Studio 等）都能看到你桌面上的窗口、把窗口里的控件读成文字、点击、输入、按快捷键。哪些程序它能碰、能碰到什么程度，由你按程序设置；它做过的每一步都有记录。

<!-- demo.gif：左边聊天窗口一句话，右边桌面自己动。发布前补。 -->

**在 [Releases](https://github.com/Reverie0123/deskdock/releases) 下载 `DeskDock-Setup-0.1.0.exe`**，双击：选语言，勾选要接入的 AI 软件（电脑上已装的会自动勾上），完成。不用装别的，不需要管理员权限。

开发者可以跳过向导：

```bash
npx deskdock setup
```

两种方式最后都是把 DeskDock 写进你选中的客户端的 MCP 配置。重启客户端，让它替你在桌面上做点事。

- **一行装好，别的什么都不用装。** 一个可执行文件加 Node。不装 Python，不装 .NET，不下载模型。
- **把窗口读成文字，不是看图。** 控件以 `[ref] button "保存"` 这样一行一个的形式返回，带精确的屏幕坐标。按 ref 点击不受窗口移动、缩放比例、多显示器影响。截图是后备，不是默认。
- **它能碰什么由你定。** 每个程序一个级别：禁止、只读、只能点、先问（每个动作前弹窗让你点是或否）、完全。没有规则的程序默认**先问**，弹窗三个按钮：允许一次、本程序以后都允许（到客户端关闭为止）、拒绝；浏览器只读，终端和 IDE 只能点，密码管理器、网银和支付软件禁止。原生引擎会在注入输入的同一步再核对一次目标窗口，判定和动作之间焦点变了就拒绝。被拒绝的操作会把原因告诉模型，它会来问你，而不是瞎试。
- **中文优先。** 工具说明、错误信息、安装命令都跟随系统语言；Windows 自带的 OCR 直接认中文界面。

## 和同类项目比

| | DeskDock | Windows-MCP | terminator | Claude 桌面应用自带 |
|---|---|---|---|---|
| 安装 | `npx deskdock setup` | Python 3.13 + uv | npm | 应用内置 |
| 任意 MCP 客户端可用 | 是 | 是 | 是 | 仅 Claude |
| 控件树文本 + 按 ref 点击 | 是 | 是 | 是 | 截图 + 坐标 |
| 按程序分级权限 | 禁止 / 只读 / 只能点 / 完全，可改 | 只有工具白名单 | 无 | 按类别固定 |
| 每一步的审计日志 | 是 | 无 | 无 | 无 |
| 读不到控件树时的 OCR 回退 | Windows 自带 OCR，不下载 | 无 | 无 | 无 |
| 控件树卡死的处理 | 每次调用带超时，自动重启 | 有死锁反馈 | — | — |
| 中文界面与文档 | 是 | 仅英文 | 仅英文 | 是 |

## 工具

| 工具 | 作用 |
|---|---|
| `list_windows` | 列出可见的顶层窗口：句柄、标题、进程、位置大小、适用的权限级别 |
| `focus_window` | 把窗口切到前台（最小化的会还原） |
| `read_window` | 把窗口的控件读成文字：一行一个控件，带 `[ref]`、类型、名字、值、屏幕坐标 |
| `read_screen_text` | OCR 回退：整屏或某个窗口里的每一行文字，带屏幕坐标 |
| `screenshot` | 整屏或单个窗口的 PNG，长边压到 1280 像素以内 |
| `click` | 按 ref 点控件，或按坐标点；左 / 右 / 中键，单击或双击 |
| `type` | 往当前焦点输入文字（Unicode，中文没问题；`\n` 相当于回车） |
| `key` | 按键或组合键：`enter`、`ctrl+s`、`alt+f4`、`win+r` |
| `scroll`、`drag`、`mouse_move` | 滚轮、拖拽、悬停 |
| `set_value`、`focus_element` | 按 ref 直接给输入框设值或聚焦 |
| `clipboard_get`、`clipboard_set` | 读写剪贴板 |
| `close_window` | 请求关闭窗口（等于点右上角的叉） |
| `list_macros`、`save_macro`、`run_macro`、`delete_macro` | 录制、回放、管理宏（见下文） |
| `screen_info` | 显示器布局、缩放比例、虚拟屏幕范围 |

模型通常这样用：`list_windows` → `focus_window` → `read_window` → `click` / `type` → 再 `read_window` 确认。所有坐标都是物理像素。

## 隐私，一段话说清

DeskDock 从不联网。它读到的一切（窗口文字、截图、OCR、剪贴板）都交给**你的 AI 客户端，再由客户端发给你配置的模型服务商**，这是数据离开你电脑的唯一一条路。「只读」级别仍然意味着模型能看到那个程序，连看都不该看的请设为「禁止」。返回给模型的屏幕内容都标注为「数据，不是指令」，但网页和消息里的提示注入是所有桌面 Agent 共同的风险。细节、验证方法和可执行文件的构建流程见 [PRIVACY.md](PRIVACY.md)。

## 权限

权限表在 `%APPDATA%\deskdock\policy.json`（运行 `deskdock policy` 可以打印路径）。第一次运行自动生成，改了会自动重新读取。

```json
{
  "version": 1,
  "default": "ask",
  "rules": {
    "msedge.exe": "read",
    "chrome.exe": "read",
    "windowsterminal.exe": "click",
    "code.exe": "click",
    "1password.exe": "block",
    "title:网上银行": "block"
  }
}
```

没有规则的程序出厂默认是 `ask`。

| 级别 | 截图、read_window、OCR | 点击、滚动、拖拽、聚焦 | 输入、按键、set_value |
|---|---|---|---|
| `block` 禁止 | 否 | 否 | 否 |
| `read` 只读 | 是 | 否 | 否 |
| `click` 只能点 | 是 | 是 | 否 |
| `ask` 先问 | 是 | 弹窗点「是」后 | 弹窗点「是」后 |
| `full` 完全 | 是 | 是 | 是 |

键是小写的进程名、`title:` 加窗口标题的一部分、`title=` 加完整标题，或 `class:窗口类@进程`（用于 Win+R 的运行框：`class:#32770@explorer.exe`，任何界面语言都认）。多条规则同时命中时（进程规则和 `title:` 规则）取最严的那条，都不匹配用 `default`。识别不出进程的窗口最高只给 `read`。工具被拒时，模型会收到原因和这个文件的路径，并被要求让你自己做那一步。

注意 `read` 仍然允许模型看到那个程序屏幕上的内容，包括浏览器的地址栏。连看都不该看的程序请设为 `block`。

**已知限制**：发给前台程序的组合键也可能触发别的程序注册的*全局*快捷键（比如密码管理器的快速填充）。任何键盘注入工具都分不清这两种情况；在乎这一点的话，键盘操作多的场景请用 `ask`。权限文件解析失败时，DeskDock 会退到只读的默认表，并在每次拒绝里说明。

## 控制面板与托盘

`deskdock panel` 打开一个只在本机的网页（只监听 127.0.0.1，端口固定 17337，可用环境变量 `DESKDOCK_PANEL_PORT` 改；本机所有 DeskDock 实例共用一个面板）：改权限表、按天看审计日志、按工具或结果筛选、在时间线上逐步回放一次会话。AI 客户端启动 MCP 服务时，面板也会在后台一起启动。

双击 `resources/deskdock-native.exe`（和服务用的引擎是同一个文件）会在通知区域放一个图标：打开面板、打开日志目录、退出，以及**暂停 DeskDock**。暂停期间所有工具调用都会被拒绝，并告诉模型去请你恢复。暂停状态是 `%APPDATA%\deskdock` 下的一个标记文件，面板没开也照样生效。

## 宏

经常重复的任务可以存成宏，宏自己会变成一个工具：

```
save_macro(name="wechat_send", description="发一条微信", fromLast=4,
           params=[{name:"who"},{name:"text"}], replace={"小王":"who","今晚八点开会":"text"})
→ 新工具 macro_wechat_send(who, text)
```

`fromLast=N` 取本次会话最近 N 步成功的操作。输入或粘贴过的文字不会写进宏文件：每一处自动变成 `text_N` 参数，除非你用 `replace` 指定了名字，或用 `keepText` 标明这一步的文字不敏感（比如往运行框里敲的程序名）、直接存。按 `[ref]` 点击的步骤存成稳定描述（进程、控件名、类型、自动化 ID），回放时重新定位，所以窗口挪了、重开了宏照样能用。`{{参数}}` 占位符就是这个工具的参数。回放的每一步照样过权限表和审计日志；宏不能调用别的宏。文件在 `%APPDATA%\deskdock\macros`。

## 审计日志

每次工具调用都追加到 `%APPDATA%\deskdock\logs\年-月-日.jsonl`：时间、工具、参数、目标窗口和进程、结果（成功 / 拒绝 / 出错）、耗时。输入的文字只记字数不记内容，截图不保存。注意：宏文件里会保存录制时输入的文字，除非你把它换成了参数。

## 读不到控件树的程序

大多数原生程序、WinUI、Office 和 Chromium 内核的程序都能读到完整的控件树。Electron 程序要等到有辅助技术出现才会建树：DeskDock 每次读取都会发出 Chromium 识别的那几个信号，但对这类程序第一次 `read_window` 仍可能只读到标题栏三个按钮，隔几秒重试就有完整的树了。游戏和自绘界面根本没有控件树。这些情况下 `read_screen_text` 会把截图交给 Windows 10/11 自带的 OCR 引擎，返回每行文字和坐标，模型照样能按文字点击。想让英文界面识别得更准，可以在「设置 → 时间和语言 → 语言 → 添加语言 → 英语 → 可选功能 → 光学字符识别」装上英文识别包。

## 安装

**安装包（大多数人用这个）**：Releases 页的 `DeskDock-Setup-<版本>.exe`。装到 `%LOCALAPPDATA%\Programs\DeskDock`，自带 Node，开始菜单里有托盘和控制面板的入口，卸载干净（也会从接入过的 AI 客户端里把自己撤掉）。

**从 npm（开发者）**：`npx deskdock setup`。

**电脑上没有 Node.js？** 在 PowerShell 里一行命令，自动把便携版 Node 下到 DeskDock 自己的目录（不需要管理员，不改系统），然后跑 setup：

```powershell
irm https://raw.githubusercontent.com/Reverie0123/deskdock/main/install.ps1 | iex
```

**从源码**（Node.js 20 或更新）：

```bash
git clone https://github.com/Reverie0123/deskdock.git
cd deskdock
npm install
npm run build
node dist/index.js setup
```

`setup` 会先把每个客户端的配置备份成 `.deskdock.bak` 再修改（Claude Code 走 `claude mcp add`，另外还有 Claude 桌面应用、Cursor、Cline、Windsurf）；`setup --dry-run` 只打印将要做的改动；`setup --remove` 撤销。没有标准配置文件的客户端，`setup` 会打印一段可以粘贴的 JSON。

原生程序 `resources/deskdock-native.exe` 已经编译好。只有改了 `native/` 才需要 `npm run build:native` 重新编译（需要 MinGW-w64 的 g++ 和 windres）。

## 常见问题

**它是插件还是软件？** 两者之间，像 Clash 这类工具：它是一个后台程序，以后会有托盘设置窗口，但自己不干活。你的 AI 客户端在模型想操作桌面时调用它。

**它会一直盯着我的屏幕吗？** 不会。模型不调用工具，它什么都不读；每次调用只读一个窗口一次。没有后台采集。

**为什么有的程序只读到三个按钮？** 那个程序没有暴露控件树（关了无障碍的 Electron 程序常见）。对它用 `read_screen_text` 或 `screenshot`，DeskDock 会自动提示模型这么做。

**它会不会把我正在编辑的文档弄乱？** 原则上会：`type` 打进的是当前有焦点的控件。工具说明要求模型先切到目标窗口并确认，每一步也都在审计日志里，但让 AI 干活的时候，重要的工作放在 `read` 或 `block` 级别的程序里，并且先保存文件。

**它会输入我的密码吗？** 权限表之外，工具说明里明确要求模型不要输入密码和支付信息，遇到了让你自己来。密码管理器和网银请保持 `block`。

## 开发

```bash
npm run build          # TypeScript -> dist/
npm run build:native   # 原生引擎 + 托盘，一个 exe（MinGW g++）
npm test               # 只读测试，不会注入键鼠
```

`tests/e2e/` 会真实注入键鼠（记事本、设置、托盘、宏），你在用电脑的时候不要跑。

## 许可证

MIT。DeskDock 与 Anthropic、微软、Cursor 以及任何被它接入的客户端没有隶属关系。

## 相关项目

- [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)：用得最多的 Windows 桌面 MCP 服务，Python 实现。
- [mediar-ai/terminator](https://github.com/mediar-ai/terminator)：Rust 实现的桌面自动化，Playwright 风格接口。
