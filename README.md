# 南京艺术学院智慧宿舍自动请假

这是一个运行在 GitHub Actions 上的宿舍请假续期工具。它会定时登录南京艺术学院智慧宿舍系统，读取现有请假记录，在满足时间条件且不存在重复记录时提交下一段请假，并通过 Server酱和 PushDeer 推送结果。

> 本项目只适用于本人账号和经过本人确认的请假安排。请遵守学校管理规定。请假能否生效仍以学校系统中的记录和审批状态为准。

## 当前规则

- 每天在北京时间 `09:17`、`16:17` 检查一次。
- 只在学校允许的 `07:00–18:00` 时段提交。
- 每段从 `18:00` 开始，62 小时后、第三天 `08:00` 结束。
- 相邻两段之间保留 `08:00–18:00` 的 10 小时间隔。
- 提前 36 小时进入可申请窗口。
- 当前请假类型为“事假”。
- 普通的“尚未到申请时间”和“已有重复记录”保持静默。
- 成功或失败时，同时通过 Server酱和 PushDeer 发送详细通知。

## 工作原理与安全保护

1. 使用保存的 WebVPN 会话进入学校网络。
2. 使用宿舍系统账号登录内部接口。
3. 查询全部请假记录并计算下一段时间。
4. 检查申请时段、提前窗口、重复记录和审批流程。
5. 所有校验通过后，最多发送一次请假 POST 请求。
6. 首次回查前等待 20 秒，随后最多进行 6 次只读记录查询；后续查询间隔 10 秒。
7. 即使 POST 响应超时，也不会自动再次提交，只会继续回查学校记录。
8. 只有在记录中确认到完全相同的起止时间，才发送成功通知。

工作流使用并发锁，避免两个定时任务重叠运行。手动运行默认是通知测试模式，必须明确选择 `submit-if-due` 才会进入请假检查与提交流程。

## 项目结构

```text
.
├── .github/workflows/dorm-leave.yml  # 定时任务与 GitHub Secrets 注入
├── scripts/api-client.cjs            # 登录、查询、提交、回查和通知逻辑
├── scripts/refresh-session-secret.cjs # 可见浏览器刷新 WebVPN 会话并复制 Secret
├── 刷新登录状态-Windows.cmd          # Windows 双击运行的一键助手
├── package.json                       # 本地会话刷新助手的依赖和命令
├── config.example.json               # 非敏感的请假规则配置
└── .gitignore                        # 阻止敏感文件被提交
```

## 如何复用

### 1. 建立自己的私有仓库

推荐从[不含凭证的模板仓库](https://github.com/wdy1218/nua-dorm-leave-template)点击 `Use this template → Create a new repository`，并将新仓库设为 **Private**。不建议直接 Fork 别人正在运行的仓库，更不要共用一个运行仓库或一组 Secrets。

GitHub 在从模板创建仓库时不会复制 Actions Secrets。每位使用者都必须在自己的私有仓库里配置自己的账号、会话和通知密钥。不要把账号、密码、Cookie、WebVPN 会话、抓包数据或真实表单内容提交到仓库。

本项目的接口地址和字段是按南京艺术学院智慧宿舍系统编写的：

- 同校、同一套智慧宿舍系统的账号，可以按下面的 Secrets 步骤配置。
- 其他学校不能直接复用，需要重新确认 WebVPN 地址、登录接口、记录接口、审批接口和提交字段。
- 不要通过脚本绕过滑块或其他安全验证；WebVPN 会话应在可见浏览器中由本人手动完成验证后导出。

### 2. 修改请假规则

编辑 `config.example.json`：

| 字段 | 作用 | 当前值 |
| --- | --- | --- |
| `leaveType` | 请假类型名称 | `事假` |
| `leaveTypeId` | 系统中的请假类型 ID | `2` |
| `boundaryTime` | 每段开始时间 | `18:00` |
| `durationHours` | 每段持续小时数，不能超过 72 | `62` |
| `leadHours` | 提前多少小时允许申请 | `36` |

账号、请假事由和去向不要写入这个文件，它们通过 GitHub Secrets 提供。

如需调整每天的检查时间，编辑 `.github/workflows/dorm-leave.yml` 中的 `schedule`。当前工作流使用 `Asia/Shanghai` 时区。

### 3. 准备 WebVPN 会话

#### Windows 小白版（推荐）

第一次使用只需要按下面操作：

1. 在自己的仓库首页点击 `Code → Download ZIP`，下载后右键选择“全部解压缩”。
2. 打开解压后的文件夹，双击 `刷新登录状态-Windows.cmd`。
3. 如果电脑没有 Node.js，脚本会提示通过 Windows 软件管理器安装；安装完成后关闭黑色窗口，再双击一次。
4. 第一次运行会自动安装所需组件，随后自动打开 Edge 或 Chrome。
5. 在浏览器里亲自完成统一认证、滑块验证和宿舍系统登录。
6. 看到“智慧宿舍管理平台”功能页后，回到黑色窗口按回车。
7. 出现“已复制到剪贴板”后，打开自己仓库的 `Settings → Secrets and variables → Actions`，更新 `NUA_SESSION_STATE_B64`，直接粘贴并保存。

以后会话过期时，不用重新下载，也不用输入命令：再次双击同一个文件即可。

> 必须先把 ZIP 完整解压，不能直接在压缩包预览窗口里运行。滑块仍需本人完成，脚本不会绕过安全验证。

#### 命令行方式（Windows、macOS、Linux）

熟悉终端的用户可以先安装 [Node.js LTS](https://nodejs.org/)，下载或克隆自己的仓库，然后在仓库目录执行：

```bash
npm install
```

然后运行仓库内的会话刷新助手：

```bash
npm run refresh-session
```

脚本会执行以下操作：

1. 打开本机可见的 Edge、Chrome 或 Playwright Chromium。
2. 打开智慧宿舍的完整 WebVPN 入口。
3. 等待本人手动完成统一认证、滑块验证和宿舍系统登录。
4. 如果统一认证后跳到其他页面，请在同一浏览器窗口重新打开最初的智慧宿舍网址。
5. 看到“智慧宿舍管理平台”功能页后，回到终端按回车。
6. 脚本将新 `storageState` 保存到本机，并把它的 Base64 编码直接复制到系统剪贴板；编码内容不会显示在终端。

默认会话文件位置：

- Windows：`%LOCALAPPDATA%\NUADormLeave\session-state.json`
- macOS：`~/Library/Application Support/NUADormLeave/session-state.json`
- Linux：`~/.config/NUADormLeave/session-state.json`

若电脑没有 Edge，而且 Playwright Chromium 尚未安装，可先运行：

```bash
npx playwright install chromium
```

如果已经通过其他本地工具刷新了会话，只想重新复制现有会话的 Base64，可运行：

```bash
npm run refresh-session -- --copy-existing
```

会话文件相当于临时登录凭证。不要上传原始 JSON，也不要在终端截图、Issue、Actions 日志或聊天中公开它。会话过期后，需要重新手动登录并更新这个 Secret。

#### 更新 GitHub 中的会话 Secret

1. 打开仓库的 `Settings → Secrets and variables → Actions`。
2. 点击现有的 `NUA_SESSION_STATE_B64`，再点击 `Update secret`。
3. 粘贴会话刷新助手已经复制到剪贴板的内容。
4. 保存后，下一次 GitHub Actions 会自动使用新会话，无需修改代码或其他 Secrets。

Windows PowerShell 备用命令（仅复制编码结果，不在终端显示）：

```powershell
$sessionPath = Join-Path $env:LOCALAPPDATA "NUADormLeave\session-state.json"
[Convert]::ToBase64String([IO.File]::ReadAllBytes($sessionPath)) | Set-Clipboard
```

macOS 终端备用命令：

```bash
base64 < "$HOME/Library/Application Support/NUADormLeave/session-state.json" | tr -d '\n' | pbcopy
```

### 4. 配置 GitHub Secrets

进入仓库：`Settings → Secrets and variables → Actions → New repository secret`，依次添加：

| Secret | 内容 |
| --- | --- |
| `NUA_ACCOUNT` | 本人的宿舍系统账号 |
| `NUA_DORM_PASSWORD` | 宿舍系统密码 |
| `NUA_SESSION_STATE_B64` | Base64 编码后的 WebVPN `storageState` |
| `NUA_REASON` | 默认请假事由 |
| `NUA_DESTINATION` | 默认去向 |
| `NUA_ENABLE_SUBMIT` | 必须填写 `I_UNDERSTAND_AUTOMATIC_SUBMISSION` |
| `SERVERCHAN_SENDKEY` | Server酱的 SendKey |
| `PUSHDEER_PUSHKEY` | PushDeer 的 PushKey |

Secret 保存后，GitHub 不会再次显示完整值。不要把真实值写进 README、工作流 YAML 或 JavaScript 文件。

如果你使用的是分享模板版，还需进入 `Settings → Secrets and variables → Actions → Variables`，新建仓库变量 `NUA_AUTOMATION_ENABLED`，值设为 `true`。模板仓库本身的定时任务默认跳过；只有自己的副本完成配置后才应启用。

## 配置通知

当前工作流要求 Server酱和 PushDeer 两个通道都已配置，任一 Secret 缺失都会在正式运行前停止。

### Server酱

Server酱用于把结果推送到微信、企业微信或 Server酱 App。

1. 打开 [Server酱 SendKey 页面](https://sct.ftqq.com/sendkey/) 并登录。
2. 生成或复制 SendKey。
3. 在 GitHub Actions Secrets 中创建 `SERVERCHAN_SENDKEY`，粘贴完整 SendKey。
4. 本项目支持以 `SCT` 开头的 Server酱 Turbo 密钥，也支持形如 `sctp...` 的 Server酱³密钥。

SendKey 就是推送凭证。泄露后别人可以向你的通道发送消息；如怀疑泄露，应立即在 Server酱后台重置，并同步更新 GitHub Secret。官方说明见 [Server酱获取 SendKey 教程](https://sct.ftqq.com/docs/getting-started/sendkey/)。

### PushDeer

PushDeer 作为独立的备用推送通道。

1. 在 iPhone 或 Mac 安装 PushDeer 官方在线版客户端。
2. 使用 Apple 账号登录。
3. 在“设备”页面注册当前设备。
4. 在“Key”页面创建一个 PushKey。
5. 在 GitHub Actions Secrets 中创建 `PUSHDEER_PUSHKEY`，粘贴完整 PushKey。

本项目通过 `https://api2.pushdeer.com/message/push` 发送 Markdown 消息，PushKey 放在 POST 请求体中，不会拼进日志 URL。PushDeer 官方项目目前仍保留在线 API，但已不再增加新功能，因此这里把它作为 Server酱之外的双保险。操作说明见 [PushDeer 官方项目文档](https://github.com/easychen/pushdeer#%E8%AF%95%E7%94%A8)。

### 通知内容

提交成功时，两路通知都会包含：

- 是否已在学校记录中确认；
- 请假类型、起止时间和总时长；
- 请假事由与去向；
- 下一段预计时间；
- 对应的 GitHub Actions 运行链接。

失败通知会包含错误摘要，并明确说明系统不会自动重试 POST。通知中不会包含账号密码、Cookie、Session 或 SendKey。

## 首次测试与启用

### 只测试通知

1. 打开仓库的 `Actions` 页面。
2. 选择 `Dorm leave automatic renewal`。
3. 点击 `Run workflow`。
4. 保持默认模式 `test-notifications` 并运行。

该模式只测试 Server酱和 PushDeer，不登录学校系统，也不会提交请假。确认两个通道都收到详细测试消息后，再进行正式检查。

### 手动正式检查

再次点击 `Run workflow`，明确选择 `submit-if-due`。该模式会登录学校系统并检查是否需要申请；只有满足全部条件且不存在相同起止时间的记录时才会提交。

如果本人刚刚撤销了同一时间段，并明确要重新申请，可手动选择 `submit-if-due-reapply-cancelled`。该模式只忽略“已撤销”的同区间记录；“审批驳回”等其他同区间记录仍会阻止提交。定时任务不会使用这个模式，因此主动撤销后不会被后台自动补回。

### 自动运行

`schedule` 会按每天 `09:17` 和 `16:17` 自动执行 `submit-if-due`。无需保持个人电脑开机，也不需要浏览器常驻。

## 如何分享给别人

推荐使用“一人一个私有仓库”的方式：

1. 把不含 Secrets 的版本设为 GitHub Template repository。
2. 对方点击 `Use this template` 创建自己的 **Private** 仓库。
3. 对方在自己的电脑运行 `npm install` 和 `npm run refresh-session`，亲自完成滑块验证。
4. 对方在自己的仓库配置全部 GitHub Secrets，并先运行 `test-notifications`。
5. 手动运行一次 `submit-if-due` 确认配置无误后，再把变量 `NUA_AUTOMATION_ENABLED` 设为 `true`。

不要直接发送或共享以下内容：`NUA_SESSION_STATE_B64`、会话 JSON、学校密码、Server酱 SendKey、PushDeer PushKey。也不要邀请别人进入你本人正在运行的仓库，因为仓库管理员可以替换工作流来读取 Secrets。

在从分享模板创建的仓库中，如果需要停止自动运行，把 `NUA_AUTOMATION_ENABLED` 改为 `false`，或在 Actions 页面禁用该工作流。会话过期时只需重新运行刷新助手并更新 `NUA_SESSION_STATE_B64`。

## 常见问题

### Actions 显示失败，但学校里已经有记录

学校接口可能在成功写入后很久才返回响应。新版脚本会在 POST 超时后继续等待和只读回查，不会重发 POST。应以学校请假记录中的起止时间和审批状态为准。

### 提示 WebVPN 会话失效

运行 `npm run refresh-session`，在本机可见浏览器中手动完成安全验证。看到智慧宿舍功能页后回到终端按回车，再把剪贴板内容粘贴到 GitHub 中现有的 `NUA_SESSION_STATE_B64` 并保存。脚本不会绕过滑块，也不会在终端打印会话内容。

### 没有收到通知

1. 先运行 `test-notifications`。
2. 查看 Actions 日志中 Server酱和 PushDeer 各自的成功或失败状态。
3. 检查客户端通知权限和 PushDeer 设备是否仍已注册。
4. 检查 SendKey/PushKey 是否被重置、复制不完整或超过服务额度。

### 为什么重复记录或未到时间时没有通知

这是有意设计的静默检查，避免每天产生大量无意义推送。只有确认提交成功或发生错误时才发送通知。

### 撤销后为什么没有自动重新申请

这是为了尊重本人的撤销操作。只有在 Actions 页面手动选择 `submit-if-due-reapply-cancelled`，才允许重新申请相同时间段。

## 敏感信息清单

以下内容绝不能提交到 Git：

- `config.json`
- WebVPN `session-state.json` 及其 Base64 内容
- 学校账号和密码
- Server酱 SendKey、PushDeer PushKey
- Cookie、AccessToken、抓包数据
- `capture.ndjson`、`submit-schema.json`
- 日志以及下载的学校前端脚本

如果任何凭证被误传到公开仓库，应立即删除公开内容并轮换对应密码、Session 和推送密钥。仅删除 Git 历史中的文件并不能让已经泄露的凭证重新安全。
