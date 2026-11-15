@echo off
chcp 65001 >nul
rem ============================================================
rem  重启 DeepSeek Harness，让「用户画像」插件的设置页生效。
rem  新增 dsh.client / 改了 index.js 后必须重启，改 client.js 则不用。
rem  本脚本先优雅关闭（保留未保存状态），3 秒后再拉起。
rem ============================================================
set "EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"

if not exist "%EXE%" (
  echo [错误] 找不到 %EXE%
  pause
  exit /b 1
)

echo [1/3] 关闭 DeepSeek Harness ...
taskkill /IM "DeepSeek Harness.exe" >nul 2>&1
if errorlevel 1 echo       进程未在运行，跳过。

echo [2/3] 等待进程退出 ...
:wait
timeout /t 1 >nul
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 goto wait

echo [3/3] 重新启动 ...
start "" "%EXE%"
echo.
echo 完成。启动后打开 设置 -> 用户画像，应能看到按权重降序排列的画像条目。
timeout /t 3 >nul
