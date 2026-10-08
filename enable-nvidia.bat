@echo off
setlocal
chcp 65001 >nul
title GhostForge - bat NVIDIA NVENC
echo.
echo ==== GhostForge: kiem tra NVIDIA NVENC ====
echo.

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo KHONG TIM THAY ffmpeg trong PATH.
  echo Cai FFmpeg full ^(gyan.dev essentials+full hoac BtbN gpl^) roi mo lai.
  pause
  exit /b 1
)

echo FFmpeg dang dung:
where ffmpeg
echo.
ffmpeg -hide_banner -version | findstr /i "ffmpeg version"
echo.

echo -- Encoder NVIDIA trong FFmpeg --
ffmpeg -hide_banner -encoders 2>nul | findstr /i nvenc
echo.

echo -- Test encode 2 frame bang h264_nvenc --
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=black:s=128x128:d=0.3 -frames:v 2 -c:v h264_nvenc -preset fast -an -f null -
if errorlevel 1 (
  echo.
  echo THAT BAI: NVENC chua mo duoc. Lam dung 4 buoc trong file BAT_NVIDIA.txt
  echo roi chay lai enable-nvidia.bat.
) else (
  echo.
  echo OK: NVENC chay duoc. Mo GhostForge, bam "Test NVIDIA again".
)
echo.
pause
