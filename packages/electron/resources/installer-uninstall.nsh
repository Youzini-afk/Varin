!ifdef BUILD_UNINSTALLER
!macro customUnInit
  StrCpy $VarinRemoveData "0"
  StrCpy $VarinDataFailed "0"
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function un.VarinResolveUserData ${UAC_SYNCREGISTERS}
  ${Else}
    Call un.VarinResolveUserData
  ${EndIf}
  StrCpy $VarinUserData "$0"
  ${StdUtils.TestParameter} $0 "delete-app-data"
  ${If} $0 == "true"
  ${AndIfNot} ${isUpdated}
    StrCpy $VarinRemoveData "1"
  ${EndIf}
  StrCpy $VarinProgressTitle "$(VarinUninstalling)"
  StrCpy $VarinProgressDescription "$(VarinRemovingFiles)"
!macroend
!macro customRemoveAppData
  ${If} $VarinRemoveData == "1"
  ${AndIfNot} ${isUpdated}
    Call un.VarinClearData
    ${If} $VarinDataFailed == "1"
      SetErrorLevel 1
    ${EndIf}
  ${EndIf}
!macroend

!macro VarinUninstallFunctions
Function un.VarinResolveUserData
  SetShellVarContext current
  StrCpy $VarinUserData "$APPDATA\${PRODUCT_FILENAME}"
  StrCpy $0 "$VarinUserData"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
FunctionEnd
Function un.VarinToggleData
  Pop $0
  ${NSD_GetState} $VarinDataControl $VarinRemoveData
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $VarinRemoveData == "1"
    ${NSD_SetText} $VarinRetentionTitle "$(VarinDeleteDataTitle)"
    ${NSD_SetText} $VarinRetentionText "$(VarinDataDescription)"
    ShowWindow $VarinDataWarning ${SW_SHOW}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinUninstallAndData)"
  ${Else}
    ${NSD_SetText} $VarinRetentionTitle "$(VarinKeepData)"
    ${NSD_SetText} $VarinRetentionText "$(VarinKeepDataSubtitle)"
    ShowWindow $VarinDataWarning ${SW_HIDE}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinUninstall)"
  ${EndIf}
FunctionEnd
Function un.VarinReadyCreate
  !insertmacro VarinPageHeader "$(VarinUninstallTitle)" "$(VarinUninstallSubtitle)"
  ${NSD_CreateLabel} 0 40% 100% 8% "$(VarinKeepData)"
  Pop $VarinRetentionTitle
  ${NSD_CreateLabel} 0 49% 100% 10% "$(VarinKeepDataSubtitle)"
  Pop $VarinRetentionText
  ${NSD_CreateCheckbox} 0 62% 100% 9% "$(VarinRemoveData)"
  Pop $VarinDataControl
  ${NSD_SetState} $VarinDataControl $VarinRemoveData
  ${NSD_OnClick} $VarinDataControl un.VarinToggleData
  ${NSD_CreateLabel} 0 73% 100% 12% "$VarinUserData"
  Pop $0
  ${NSD_CreateLabel} 0 85% 100% 9% "$(VarinDataWarning)"
  Pop $VarinDataWarning
  ${NSD_CreateLabel} 0 94% 100% 6% "$(VarinKeepProjects)"
  Pop $0
  Call un.VarinStylePage
  Push 0
  Call un.VarinToggleData
  nsDialogs::Show
FunctionEnd
Function un.VarinReadyLeave
  ${NSD_GetState} $VarinDataControl $VarinRemoveData
FunctionEnd
Function un.VarinDeleteUserData
  Call un.VarinResolveUserData
  VarinSetup::RemoveData "$VarinUserData"
  Pop $0
  Pop $1
  ${If} $0 != "0"
    DetailPrint "$1"
  ${EndIf}
FunctionEnd
Function un.VarinClearData
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function un.VarinDeleteUserData ${UAC_SYNCREGISTERS}
  ${Else}
    Call un.VarinDeleteUserData
  ${EndIf}
  StrCpy $VarinDataFailed "0"
  ${If} $0 != "0"
    StrCpy $VarinDataFailed "1"
  ${EndIf}
FunctionEnd
Function un.VarinRetryData
  Pop $0
  Call un.VarinClearData
  ${If} $VarinDataFailed == "0"
    ${NSD_SetText} $VarinSubtitle "$(VarinDataRemoved)"
    ShowWindow $VarinDataControl ${SW_HIDE}
    SetErrorLevel 0
  ${EndIf}
FunctionEnd
Function un.VarinFinishCreate
  !insertmacro VarinPageHeader "$(VarinUninstalled)" "$(VarinDataKept)"
  ${If} $VarinRemoveData == "1"
    ${NSD_SetText} $VarinSubtitle "$(VarinDataRemoved)"
  ${EndIf}
  ${If} $VarinDataFailed == "1"
    ${NSD_SetText} $VarinSubtitle "$(VarinDataFailed)"
    ${NSD_CreateLabel} 0 42% 100% 15% "$VarinUserData"
    Pop $0
    ${NSD_CreateButton} 0 64% 55% 11% "$(VarinRetry)"
    Pop $VarinDataControl
    ${NSD_OnClick} $VarinDataControl un.VarinRetryData
    SetErrorLevel 1
  ${EndIf}
  Call un.VarinStylePage
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinFinish)"
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  nsDialogs::Show
FunctionEnd
!macroend
!endif
