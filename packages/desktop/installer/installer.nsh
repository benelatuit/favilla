; Additions to electron-builder's installer (nsis.include in build.mjs). The favilla and fav commands are in
; resources\bin beside the app: installing puts that folder on the user's Path and uninstalling takes it off.
; user-path.ps1 edits the value, since NSIS strings end at 1024 characters and a longer Path read into one would be
; written back cut short, losing the user's other entries.
!macro favillaUserPath ACTION
  InitPluginsDir
  File "/oname=$PLUGINSDIR\user-path.ps1" "${BUILD_RESOURCES_DIR}\user-path.ps1"
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\user-path.ps1" ${ACTION} "$INSTDIR\resources\bin"'
  Pop $0
  ; Terminals already open keep the Path they started with; new ones, and Explorer, read the new value.
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=500
!macroend

!macro customInstall
  !insertmacro favillaUserPath add
!macroend

!macro customUnInstall
  !insertmacro favillaUserPath remove
!macroend
