@echo off
rem The favilla command of the installed app: Favilla.exe as Node on the command's bundle (src/cli.ts).
rem The installer puts this folder on the user's PATH.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Favilla.exe" "%~dp0..\app.asar\cli.mjs" %*
exit /b %errorlevel%
