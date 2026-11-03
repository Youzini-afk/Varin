; Tauri Windows notifications keep the original application identity. The
; callback is an unpackaged Win32 COM local server, not a protocol/URL handler.
; Keep these constants synchronized with native_notifications_windows_policy.rs.
!define VARIN_NOTIFICATION_AUMID "dev.varin.desktop"
!define VARIN_NOTIFICATION_CLSID "{34EDFA49-F833-482E-A268-C1D3610E6F17}"
!define VARIN_NOTIFICATION_FLAG "--varin-notification-activation"
!define VARIN_NOTIFICATION_CLASS_KEY "Software\Classes\CLSID\${VARIN_NOTIFICATION_CLSID}"
!define VARIN_NOTIFICATION_APP_KEY "Software\Classes\AppUserModelId\${VARIN_NOTIFICATION_AUMID}"

!macro VarinInstallNotifications
  ; electron-builder has selected the install scope and native registry view.
  ; The quoted executable is the staged CEF bootstrap, never the Cargo stub.
  WriteRegStr SHCTX "${VARIN_NOTIFICATION_CLASS_KEY}\LocalServer32" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" ${VARIN_NOTIFICATION_FLAG}'
  WriteRegStr SHCTX "${VARIN_NOTIFICATION_APP_KEY}" "CustomActivator" "${VARIN_NOTIFICATION_CLSID}"
  WriteRegStr SHCTX "${VARIN_NOTIFICATION_APP_KEY}" "DisplayName" "Varin"
  WriteRegStr SHCTX "${VARIN_NOTIFICATION_APP_KEY}" "VarinNotificationOwner" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ; The native owner installs the original PNG IconUri and refreshes HKCU for
  ; the actual signed-in user, including when this is a per-machine install.
!macroend

!macro VarinRemoveNotificationRegistration ROOT
  ReadRegStr $R0 ${ROOT} "${VARIN_NOTIFICATION_CLASS_KEY}\LocalServer32" ""
  ${If} $R0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" ${VARIN_NOTIFICATION_FLAG}'
    DeleteRegKey ${ROOT} "${VARIN_NOTIFICATION_CLASS_KEY}"
    ReadRegStr $R0 ${ROOT} "${VARIN_NOTIFICATION_APP_KEY}" "VarinNotificationOwner"
    ReadRegStr $R1 ${ROOT} "${VARIN_NOTIFICATION_APP_KEY}" "CustomActivator"
    ${If} $R0 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${AndIf} $R1 == "${VARIN_NOTIFICATION_CLSID}"
      DeleteRegValue ${ROOT} "${VARIN_NOTIFICATION_APP_KEY}" "CustomActivator"
      DeleteRegValue ${ROOT} "${VARIN_NOTIFICATION_APP_KEY}" "DisplayName"
      DeleteRegValue ${ROOT} "${VARIN_NOTIFICATION_APP_KEY}" "IconUri"
      DeleteRegValue ${ROOT} "${VARIN_NOTIFICATION_APP_KEY}" "VarinNotificationOwner"
      DeleteRegKey /ifempty ${ROOT} "${VARIN_NOTIFICATION_APP_KEY}"
    ${EndIf}
  ${EndIf}
!macroend

!macro VarinUninstallNotifications
  ; Never delete a registration now owned by another install/update path. A
  ; machine uninstall cannot enumerate or modify other users' private hives.
  !insertmacro VarinRemoveNotificationRegistration SHCTX
  !insertmacro VarinRemoveNotificationRegistration HKCU
!macroend
