!include "LogicLib.nsh"
!include "nsProcess.nsh"

# electron-builder 26 checks every executable under $INSTDIR. During an update
# that includes its own old uninstaller and causes a false "app cannot be closed"
# loop. Only the actual desktop executable should participate in this check.
!macro customCheckAppRunning
  !insertmacro nsProcess::FindProcess "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    DetailPrint "$(appClosing)"
    !insertmacro nsProcess::CloseProcess "${APP_EXECUTABLE_FILENAME}" $R0
    Sleep 1500

    !insertmacro nsProcess::FindProcess "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      !insertmacro nsProcess::KillProcess "${APP_EXECUTABLE_FILENAME}" $R0
      Sleep 500
    ${EndIf}
  ${EndIf}

  # Older uninstallers can mistake their own temporary process for Ritim and
  # show "app cannot be closed" even after every Ritim.exe process has exited.
  # Once the real app is closed, move any previous installation into this
  # installer's temporary directory and replace it directly. User data lives
  # outside $INSTDIR, so pairing, login and settings remain intact.
  ReadRegStr $R8 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $R8 != ""
    SetOutPath "$TEMP"
    ClearErrors
    Rename "$INSTDIR" "$PLUGINSDIR\ritim-previous-install"
    ${If} ${Errors}
      Sleep 1000
      ClearErrors
      Rename "$INSTDIR" "$PLUGINSDIR\ritim-previous-install"
    ${EndIf}
    ${IfNot} ${Errors}
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    ${EndIf}
  ${EndIf}
!macroend
