# 清场 · dsh-window-sweeper

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的收尾插件：**任务做完，把 AI 自己开的窗口收掉。**

AI 跑任务时常常顺手打开记事本、浏览器、资源管理器、安装向导、播放器……收尾时没人管，桌面就堆满窗口。
清场在**每个任务开始时**给当时已有的窗口拍一张基线快照，收尾时只处理**基线之后新出现**的窗口——
你自己开着的窗口不会被动。

## 能力

- 工具 `window_sweep`：`mark`（重拍基线）/ `list`（看候选）/ `minimize`（最小化，默认）/ `close`（关闭），作为自动清场之外的兜底。
- 默认动作是**最小化**（可恢复）；可在设置里改成**直接关闭**。
- 每个任务开始时自动拍基线；**任务收尾时自动清场**（`agent/turn-stopping` 钩子），模型忘了调工具也会收。
- 子任务（subagent）不自动清场，避免把主会话刚开的窗口提前收掉；工具仍可手动用。
- 内置浏览器标签不在这里硬关（避免误关 DSH 主窗口），提示模型用 `dsh_browser_reset_session`。
- 设置界面：**DSH 设置 → 清场**，可改动作、进程排除名单、标题关键词黑名单。

## 安装

在 DSH 里打开 **设置 → 插件管理器**，安装下面任一来源：

```
github:Yyhy110421/dsh-window-sweeper
```

```
file:<本仓库的绝对路径>
```

装完**重启 DSH** 生效。

> 注意：`file:` 安装是**实体拷贝**，改完源码要卸载再装才会更新；`update` 只支持 npm 注册表插件。
> 本插件不发布到 npm。

## 配置

设置文件：`$DSH_HOME/data/window-sweeper.json`（没有 DSH_HOME 时用 `~/.dsh`）。

```json
{
  "action": "minimize",
  "excludeExe": ["explorer", "ShellExperienceHost", "StartMenuExperienceHost", "SearchHost", "TextInputHost", "LockApp"],
  "excludeTitleKeywords": []
}
```

- `action`：`minimize` | `close`。
- `excludeExe`：按进程名（不带 .exe）排除。
- `excludeTitleKeywords`：标题包含任一关键词就跳过。

## 安全边界

1. 只动**基线之后**出现的窗口（hwnd 和 pid 都不在基线里）。
2. 系统外壳进程默认不动。
3. 最小化用 `ShowWindow(SW_MINIMIZE)`，可恢复；关闭只发 `WM_CLOSE`，不杀进程。
4. 只支持 Windows。

## 已知限制

- 单实例程序（如记事本）如果在**旧进程**里开新窗口，会被判为「任务前就存在」而收不到。这是为了不误伤你自己窗口所付的代价。
- 任务期间你自己新开的窗口也会被当成候选；用进程名单或标题黑名单排除。

## 开发

```bash
node test/manual.mjs   # 在真实的 Windows 桌面上跑一遍 list/minimize/close
```

宿主部分零第三方依赖；窗口枚举/操作在 `lib/windows.ps1`（Add-Type + Win32 API）。

## License

MIT © 2026 Yyhy110421
