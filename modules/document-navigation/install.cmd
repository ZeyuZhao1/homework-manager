@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed. Please keep this window open and report the error above.
  pause
  exit /b 1
)
echo.
echo Installation completed. Refresh the module list in Homework Manager.
pause
