@echo off
setlocal
cd /d "%~dp0"
title GhostForge AI
where node >nul 2>&1
if errorlevel 1 goto missingnode
where ffmpeg >nul 2>&1
if errorlevel 1 echo WARNING: FFmpeg is missing from PATH.
if exist "node_modules\" goto run
call npm ci --no-audit --no-fund --cache "%~dp0.npm-cache"
if errorlevel 1 goto failed
:run
call npm start
if errorlevel 1 goto failed
exit /b 0
:missingnode
echo Install Node.js, then run start.bat again.
:failed
echo GhostForge could not start. See the error above.
pause
exit /b 1
