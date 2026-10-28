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
LangString VarinWorkspaceTitle 1033 "Independent workspaces"
LangString VarinWorkspaceTitle 2052 "独立工作区"
LangString VarinWorkspaceTitle 1028 "獨立工作區"
LangString VarinWorkspaceHint 1033 "Optional WinFsp enables isolated Agent workspaces. Normal chats and shared tasks work without it. Installing this system component asks for Windows permission."
LangString VarinWorkspaceHint 2052 "可选的 WinFsp 为 Agent 提供独立工作区。普通会话和共享任务无需安装；安装此系统组件时 Windows 会请求授权。"
LangString VarinWorkspaceHint 1028 "選用的 WinFsp 為 Agent 提供獨立工作區。一般對話和共用任務無需安裝；安裝此系統元件時 Windows 會請求授權。"
LangString VarinWorkspaceCheck 1033 "Install or update WinFsp (${VARIN_WINFSP_RELEASE})"
LangString VarinWorkspaceCheck 2052 "安装或更新 WinFsp（${VARIN_WINFSP_RELEASE}）"
LangString VarinWorkspaceCheck 1028 "安裝或更新 WinFsp（${VARIN_WINFSP_RELEASE}）"
LangString VarinWorkspaceReuse 1033 "A compatible WinFsp is already installed and will be reused."
LangString VarinWorkspaceReuse 2052 "已检测到兼容的 WinFsp，将复用现有组件。"
LangString VarinWorkspaceReuse 1028 "已偵測到相容的 WinFsp，將使用現有元件。"
LangString VarinWorkspaceSkipped 1033 "WinFsp was not installed (result $VarinWorkspaceResult). Varin remains usable; install the component later to enable independent workspaces."
LangString VarinWorkspaceSkipped 2052 "WinFsp 未完成安装（结果 $VarinWorkspaceResult）。Varin 仍可正常使用，之后安装组件即可启用独立工作区。"
LangString VarinWorkspaceSkipped 1028 "WinFsp 未完成安裝（結果 $VarinWorkspaceResult）。Varin 仍可正常使用，之後安裝元件即可啟用獨立工作區。"
LangString VarinWorkspaceRestart 1033 "WinFsp requires a Windows restart. Varin is installed; independent workspaces become available after restarting Windows."
LangString VarinWorkspaceRestart 2052 "WinFsp 需要重启 Windows。Varin 已安装，重启 Windows 后可使用独立工作区。"
LangString VarinWorkspaceRestart 1028 "WinFsp 需要重新啟動 Windows。Varin 已安裝，重新啟動 Windows 後可使用獨立工作區。"

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
