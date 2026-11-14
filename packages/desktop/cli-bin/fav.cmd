@echo off
rem fav is favilla for short (favilla.cmd says how it runs).
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Favilla.exe" "%~dp0..\app.asar\cli.mjs" %*
exit /b %errorlevel%
