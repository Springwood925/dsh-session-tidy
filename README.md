# dsh-session-tidy

DSH（DeepSeek Harness）插件：无感整理会话与工作区。装一次，之后它自己跑。

## 功能

- **自动归档**：把 N 天（默认 30）没有活动、不在运行中、未置顶的会话归档。只归档、不删除，随时可取消归档
- **同会话去重**：客户端/机器人轮换留下的同一会话旧版本（标题形如 `群名 10-27 15:55`），同一分组只保留最新 1 个，其余自动归档
- **归档前备份**：归档前把会话文件复制到备份目录（默认 `~/.dsh/session-tidy-backup/<日期>/<会话id>/`）
- **工作区清理**：闲置超过 N 天、且不在白名单里的工作区注册会被删除（只删注册，不删目录与会话；删除前先备份记录）
- **配置全在插件详情页里改**：保存立即生效，不用手改配置文件、不用重启

## 安装

在 DSH profile 里用插件管理器安装本目录：

```
plugin_manager install_bundle <本目录绝对路径>
```

装好后在「扩展包」列表找到 `dsh-session-tidy`，详情页就是配置面板。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `days` | 30 | 多少天没活动才归档会话 |
| `intervalHours` | 6 | 检查间隔（小时） |
| `runOnStart` | true | DSH 启动后先检查一次 |
| `keepPinned` / `keepLive` | true | 不碰置顶 / 运行中的会话 |
| `dedupeTitles` / `keepPerTitle` | true / 1 | 同会话去重，每组保留最新几个 |
| `workspaceDays` | 30 | 工作区闲置多少天后清理（0 = 不清理） |
| `keepWorkspaces` | 空 | 保留的工作区路径前缀，逗号分隔 |
| `backupEnabled` / `backupDir` | true / 空 | 归档前备份；留空 = `~/.dsh/session-tidy-backup` |
| `dryRun` | false | 只记日志、不真正归档 |

## 数据位置

- 配置：`~/.dsh/session-tidy.json`
- 日志：`~/.dsh/session-tidy.log`
- 备份：`~/.dsh/session-tidy-backup/`（或自定义目录）

## 安全说明

只调用 DSH 的 `workspaceController.archiveSession` / `workspaceRegistry.delete`——归档与清理都是可逆操作，**不删除任何会话文件**。

## 许可

MIT。本项目的改动同样以 MIT 开源。
