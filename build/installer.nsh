!include "LogicLib.nsh"
!include "nsProcess.nsh"

# 0.9.1-beta.1 was built locally and shipped the phone-only Capacitor packages
# (Android sources and android/build outputs) under app.asar.unpacked. Their
# paths reach 249 characters; electron-builder's old uninstaller moves every
# file to "$PLUGINSDIR\old-install\..." first, which is longer than MAX_PATH,
# so the move fails and the update aborts with "Failed to uninstall old
# application files: 2". Deleting these two folders in place still works
# because their own paths stay below 260 characters. Only these two folders of
# an existing Ritim installation are touched; user data under %APPDATA% never.
!macro ritimRemovePhoneOnlyPackages
  ${If} "$INSTDIR" != ""
  ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${AndIf} ${FileExists} "$INSTDIR\resources\app.asar"
    ${If} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\node_modules\@capacitor\*.*"
      RMDir /r "$INSTDIR\resources\app.asar.unpacked\node_modules\@capacitor"
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\node_modules\@capacitor-mlkit\*.*"
      RMDir /r "$INSTDIR\resources\app.asar.unpacked\node_modules\@capacitor-mlkit"
    ${EndIf}
  ${EndIf}
!macroend

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

  !insertmacro ritimRemovePhoneOnlyPackages

  # 0.7.0-0.7.2 uninstallers contain the same broad process check and mistake
  # their own temporary uninstaller for Ritim. Move only those legacy installs
  # out of the way. Modern releases must use electron-builder's normal
  # uninstallOldVersion/registryAddInstallInfo flow so Windows receives the
  # current DisplayName, DisplayVersion and uninstall metadata.
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
