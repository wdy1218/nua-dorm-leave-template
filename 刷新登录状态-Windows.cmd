@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title 智慧宿舍登录状态刷新

echo ============================================================
echo   智慧宿舍登录状态刷新（Windows 一键版）
echo ============================================================
echo.
echo 这个工具只会在本机打开浏览器并保存登录状态。
echo 它不会读取、显示或上传你的学校密码。
echo.

if not exist "package.json" (
  echo [错误] 请先完整解压下载的 ZIP，再双击这个文件。
  goto :failed
)

where node >nul 2>&1
if errorlevel 1 goto :install_node

where npm >nul 2>&1
if errorlevel 1 (
  echo [错误] 已找到 Node.js，但没有找到 npm。
  echo 请重新安装 Node.js LTS，然后再双击本文件。
  goto :failed
)

if not exist "node_modules\playwright\package.json" (
  echo [1/2] 首次使用，正在自动安装所需组件，请稍候……
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 组件安装失败，请检查网络后重试。
    goto :failed
  )
) else (
  echo [1/2] 所需组件已经安装。
)

echo.
echo [2/2] 即将打开浏览器。
echo 请亲自完成统一认证、滑块验证和宿舍系统登录。
echo 看到“智慧宿舍管理平台”功能页后，回到本窗口按回车。
echo.
call npm run refresh-session
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo   完成：NUA_SESSION_STATE_B64 已复制到剪贴板
echo ============================================================
echo 接下来到你自己的 GitHub 仓库：
echo Settings -^> Secrets and variables -^> Actions
echo 更新 NUA_SESSION_STATE_B64，直接粘贴并保存。
echo.
pause
exit /b 0

:install_node
echo [提示] 这台电脑还没有安装 Node.js LTS。
where winget >nul 2>&1
if errorlevel 1 (
  echo 即将打开 Node.js 官方下载页面。
  echo 安装 LTS 版本后，请再次双击本文件。
  start "" "https://nodejs.org/zh-cn/download"
  goto :failed
)

echo 按任意键后，将通过 Windows 软件管理器安装 Node.js LTS。
echo 如果系统弹出权限提示，请核对发布者后选择允许。
pause >nul
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo [错误] Node.js 安装没有完成。
  echo 请从 https://nodejs.org/zh-cn/download 手动安装 LTS 版本。
  goto :failed
)

echo.
echo Node.js 已安装。请关闭本窗口，然后再次双击本文件。
pause
exit /b 0

:failed
echo.
echo 操作没有完成，请根据上面的提示处理后重试。
pause
exit /b 1
