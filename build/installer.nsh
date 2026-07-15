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

  # 0.7.0-0.7.2 uninstallers contain the same broad process check and mistake
  # their own temporary uninstaller for Ritim. Move that closed installation
  # into NSIS' temporary directory and let this installer replace it directly.
  ReadRegStr $R8 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $R8 == "0.7.0"
  ${OrIf} $R8 == "0.7.1"
  ${OrIf} $R8 == "0.7.2"
    SetOutPath "$TEMP"
    ClearErrors
    Rename "$INSTDIR" "$PLUGINSDIR\ritim-legacy-install"
    ${IfNot} ${Errors}
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    ${EndIf}
  ${EndIf}
!macroend
