; The unmodified, checksum-pinned upstream MSI is prepared before packaging.
; This optional explicit page owns system installation, never dispatch/runtime.
!ifndef BUILD_UNINSTALLER
!include "WordFunc.nsh"
!include "x64.nsh"
!include "${__FILEDIR__}\workspace-component\component.nsh"
!define VARIN_WINFSP_MSI "${__FILEDIR__}\workspace-component\${VARIN_WINFSP_FILE}"
Var VarinWorkspaceChoice
Var VarinWorkspaceCheckbox
Var VarinWorkspaceResult
Var VarinWorkspaceInstalled
!include "${__FILEDIR__}\workspace-component\strings.nsh"

!macro VarinWorkspaceFunctions
Function VarinWorkspaceCreate
  ; Quiet updates never acquire a new system component by implication.
  IfSilent 0 +2
    Abort
  !insertmacro VarinPageHeader "$(VarinWorkspaceTitle)" ""
  ${NSD_CreateLabel} 0 31% 100% 24% "$(VarinWorkspaceHint)"
  Pop $0
  ${NSD_CreateCheckbox} 0 59% 100% 10% "$(VarinWorkspaceCheck)"
  Pop $VarinWorkspaceCheckbox
  StrCpy $VarinWorkspaceInstalled ""
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\WinFsp" "InstallDir"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\WinFsp" "InstallDir"
  ${EndIf}
  SetRegView lastused
  ${If} $0 != ""
    ${If} ${IsNativeARM64}
      ${GetFileVersion} "$0\bin\winfsp-a64.dll" $VarinWorkspaceInstalled
    ${ElseIf} ${RunningX64}
      ${GetFileVersion} "$0\bin\winfsp-x64.dll" $VarinWorkspaceInstalled
    ${Else}
      ${GetFileVersion} "$0\bin\winfsp-x86.dll" $VarinWorkspaceInstalled
    ${EndIf}
    ${VersionCompare} "$VarinWorkspaceInstalled" "${VARIN_WINFSP_VERSION}" $1
    ${If} $1 != 2
      ${NSD_CreateLabel} 0 71% 100% 13% "$(VarinWorkspaceReuse)"
      Pop $0
      EnableWindow $VarinWorkspaceCheckbox 0
      StrCpy $VarinWorkspaceChoice "0"
    ${EndIf}
  ${EndIf}
  ${NSD_SetState} $VarinWorkspaceCheckbox $VarinWorkspaceChoice
  Call VarinStylePage
  nsDialogs::Show
FunctionEnd
Function VarinWorkspaceLeave
  ${NSD_GetState} $VarinWorkspaceCheckbox $VarinWorkspaceChoice
  ${If} $VarinWorkspaceChoice != ${BST_CHECKED}
    Return
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\${VARIN_WINFSP_FILE}" "${VARIN_WINFSP_MSI}"
  ClearErrors
  ExecShellWait "runas" "$SYSDIR\msiexec.exe" '/i "$PLUGINSDIR\${VARIN_WINFSP_FILE}" /passive /norestart' SW_SHOWNORMAL $VarinWorkspaceResult
  ${If} ${Errors}
    StrCpy $VarinWorkspaceResult "cancelled or unavailable"
  ${EndIf}
  ${If} $VarinWorkspaceResult == "3010"
    MessageBox MB_ICONINFORMATION "$(VarinWorkspaceRestart)"
  ${ElseIf} $VarinWorkspaceResult != "0"
    MessageBox MB_ICONEXCLAMATION "$(VarinWorkspaceSkipped)"
  ${EndIf}
FunctionEnd
!macroend
!endif
