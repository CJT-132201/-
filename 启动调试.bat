@echo off
chcp 65001 >nul
title 桌面智能助手 (调试版)
cd /d "C:\Users\MECHREVO\.astrbot\data\workspaces\webchat_FriendMessage_webchat_astrbot_d2fbe9c1-5d86-4964-a8d7-ec51f2f9cb62"
echo ============================================
echo   桌面智能助手 (调试版) - 正在启动...
echo   关闭弹出的窗口即可退出
echo ============================================
if exist "node_modules\.bin\electron.cmd" (
  "node_modules\.bin\electron.cmd" .
) else (
  npx electron .
)
pause
