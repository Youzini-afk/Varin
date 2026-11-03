; Register only Varin's own scheme in the selected installation scope. Never
; overwrite Windows UserChoice or remove a registration owned by another path.
!define VARIN_PROTOCOL_KEY "Software\Classes\varin"
!macro VarinInstallProtocol
  WriteRegStr SHCTX "${VARIN_PROTOCOL_KEY}" "" "URL:Varin Protocol"
  WriteRegStr SHCTX "${VARIN_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr SHCTX "${VARIN_PROTOCOL_KEY}" "VarinProtocolOwner" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "${VARIN_PROTOCOL_KEY}\DefaultIcon" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr SHCTX "${VARIN_PROTOCOL_KEY}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
!macroend
!macro VarinRemoveProtocol ROOT
  ReadRegStr $R0 ${ROOT} "${VARIN_PROTOCOL_KEY}\shell\open\command" ""
  ReadRegStr $R1 ${ROOT} "${VARIN_PROTOCOL_KEY}" "VarinProtocolOwner"
  ${If} $R0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  ${AndIf} $R1 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DeleteRegKey ${ROOT} "${VARIN_PROTOCOL_KEY}"
  ${EndIf}
!macroend
!macro VarinUninstallProtocol
  !insertmacro VarinRemoveProtocol SHCTX
  !insertmacro VarinRemoveProtocol HKCU
!macroend
