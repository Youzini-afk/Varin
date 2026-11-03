; Preserve the established Varin NSIS identity, installation UI, optional WinFsp
; page, upgrade removal and explicit data-retention policy. Native-only hooks are
; separate so the still-shipping Electron installer is not modified prematurely.
!include "${__FILEDIR__}\..\..\electron\resources\installer.nsh"
!include "${__FILEDIR__}\notification-registration.nsh"
!include "${__FILEDIR__}\protocol-registration.nsh"

!macro customInstall
  !insertmacro VarinInstallNotifications
  !insertmacro VarinInstallProtocol
!macroend
!macro customUnInstall
  !insertmacro VarinUninstallProtocol
  !insertmacro VarinUninstallNotifications
!macroend
