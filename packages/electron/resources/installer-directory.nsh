!ifndef VARIN_INSTALLER_DIRECTORY_INCLUDED
!define VARIN_INSTALLER_DIRECTORY_INCLUDED
!include "LogicLib.nsh"
!include "FileFunc.nsh"

; The raw selection stays in an ordinary variable. Reading $INSTDIR strips its
; trailing slash, so resolving a drive root through it turns D:\ into the
; drive-relative D: and picks up the installer's working directory.
!macro VarinDirectoryFunctions
Function VarinResolveInstallDirectory
  Push $0
  Push $1
  ClearErrors
  StrLen $0 "$VarinDesiredDirectory"
  StrCpy $1 "$VarinDesiredDirectory" 1 1
  ${If} $0 == 2
  ${AndIf} $1 == ":"
    StrCpy $VarinDesiredDirectory "$VarinDesiredDirectory\"
  ${EndIf}
  ; NSIS GetFullPathName can reject a missing final component. Installation
  ; targets normally don't exist yet; the Windows API only resolves the path.
  System::Call 'kernel32::GetFullPathNameW(w "$VarinDesiredDirectory", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    Pop $1
    Pop $0
    SetErrors
    Return
  ${EndIf}
  StrCpy $VarinDesiredDirectory "$0"
  varin_trim:
    StrLen $0 "$VarinDesiredDirectory"
    IntCmp $0 3 varin_trim_done varin_trim_done
    StrCpy $1 "$VarinDesiredDirectory" 1 -1
    StrCmp "$1" "\" 0 varin_trim_done
    StrCpy $VarinDesiredDirectory "$VarinDesiredDirectory" -1
    Goto varin_trim
  varin_trim_done:
  ${GetFileName} "$VarinDesiredDirectory" $0
  ${If} $0 != "${PRODUCT_FILENAME}"
    StrCpy $1 "$VarinDesiredDirectory" 1 -1
    ${If} $1 == "\"
      StrCpy $VarinDesiredDirectory "$VarinDesiredDirectory${PRODUCT_FILENAME}"
    ${Else}
      StrCpy $VarinDesiredDirectory "$VarinDesiredDirectory\${PRODUCT_FILENAME}"
    ${EndIf}
  ${EndIf}
  StrCpy $INSTDIR "$VarinDesiredDirectory"
  Pop $1
  Pop $0
  ClearErrors
FunctionEnd
!macroend
!endif
