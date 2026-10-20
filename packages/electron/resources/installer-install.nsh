!ifndef BUILD_UNINSTALLER
!define VARIN_INSTALLER_LICENSE "${__FILEDIR__}\..\..\..\LICENSE"
!macro customInit
  StrCpy $VarinShortcut "1"
  ${If} ${isNoDesktopShortcut}
    StrCpy $VarinShortcut "0"
  ${EndIf}
  StrCpy $VarinOptionsOpen "0"
  StrCpy $VarinDesiredDirectory "$INSTDIR"
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_GetGlobal $VarinDesiredDirectory $VarinDesiredDirectory
    !insertmacro UAC_AsUser_GetGlobal $VarinShortcut $VarinShortcut
    !insertmacro setInstallModePerAllUsers
    StrCpy $INSTDIR "$VarinDesiredDirectory"
  ${EndIf}
  StrCpy $VarinIsUpgrade "0"
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $VarinIsUpgrade "1"
  ${EndIf}
  StrCpy $VarinProgressTitle "$(VarinInstalling)"
  ${If} $VarinIsUpgrade == "1"
    StrCpy $VarinProgressTitle "$(VarinUpdating)"
  ${EndIf}
  StrCpy $VarinProgressDescription "$(VarinProgressSubtitle)"
!macroend

!macro VarinInstallFunctions
Function VarinResolveInstallDirectory
  ; Preserve an explicitly selected Varin folder and normalize trailing separators.
  GetFullPathName $INSTDIR "$INSTDIR"
  varin_trim:
    StrLen $0 "$INSTDIR"
    IntCmp $0 3 varin_trim_done varin_trim_done
    StrCpy $1 "$INSTDIR" 1 -1
    StrCmp "$1" "\" 0 varin_trim_done
    StrCpy $INSTDIR "$INSTDIR" -1
    Goto varin_trim
  varin_trim_done:
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 != "${PRODUCT_FILENAME}"
    StrCpy $1 "$INSTDIR" 1 -1
    ${If} $1 == "\"
      StrCpy $INSTDIR "$INSTDIR${PRODUCT_FILENAME}"
    ${Else}
      StrCpy $INSTDIR "$INSTDIR\${PRODUCT_FILENAME}"
    ${EndIf}
  ${EndIf}
FunctionEnd
Function VarinDirectoryBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "$(VarinLocation)" "$INSTDIR"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    StrCpy $INSTDIR "$0"
    Call VarinResolveInstallDirectory
    ${NSD_SetText} $VarinDirectoryInput "$INSTDIR"
  ${EndIf}
FunctionEnd
Function VarinToggleOptions
  Pop $0
  ${If} $VarinOptionsOpen == "0"
    StrCpy $VarinOptionsOpen "1"
    ShowWindow $VarinScopeControl ${SW_SHOW}
    ShowWindow $VarinAllUsersControl ${SW_SHOW}
  ${Else}
    StrCpy $VarinOptionsOpen "0"
    ShowWindow $VarinScopeControl ${SW_HIDE}
    ShowWindow $VarinAllUsersControl ${SW_HIDE}
  ${EndIf}
FunctionEnd
Function VarinLicense
  Pop $0
  InitPluginsDir
  File "/oname=$PLUGINSDIR\Varin-LICENSE.txt" "${VARIN_INSTALLER_LICENSE}"
  ExecShell "open" "$PLUGINSDIR\Varin-LICENSE.txt"
FunctionEnd
Function VarinScopeChanged
  Pop $0
  ${NSD_GetState} $VarinAllUsersControl $1
  ${If} $1 == ${BST_CHECKED}
    !insertmacro setInstallModePerAllUsers
  ${Else}
    !insertmacro setInstallModePerUser
  ${EndIf}
  ${NSD_SetText} $VarinDirectoryInput "$INSTDIR"
  Call VarinReadyState
FunctionEnd
Function VarinReadyState
  StrCpy $VarinIsUpgrade "0"
  GetDlgItem $0 $HWNDPARENT 1
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $VarinIsUpgrade "1"
    ${NSD_SetText} $VarinTitle "$(VarinUpdateTitle)"
    ${NSD_SetText} $VarinSubtitle "$(VarinUpdateSubtitle)"
    ${NSD_SetText} $VarinDirectoryLabel "$INSTDIR"
    ShowWindow $VarinDirectoryInput ${SW_HIDE}
    ShowWindow $VarinDirectoryLabel ${SW_SHOW}
    ShowWindow $VarinBrowseButton ${SW_HIDE}
    ShowWindow $VarinShortcutControl ${SW_HIDE}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinUpdate)"
    StrCpy $VarinProgressTitle "$(VarinUpdating)"
  ${Else}
    ${NSD_SetText} $VarinTitle "$(VarinInstallTitle)"
    ${NSD_SetText} $VarinSubtitle "$(VarinInstallSubtitle)"
    ShowWindow $VarinDirectoryInput ${SW_SHOW}
    ShowWindow $VarinDirectoryLabel ${SW_HIDE}
    ShowWindow $VarinBrowseButton ${SW_SHOW}
    ShowWindow $VarinShortcutControl ${SW_SHOW}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinInstall)"
    StrCpy $VarinProgressTitle "$(VarinInstalling)"
  ${EndIf}
FunctionEnd
Function VarinReadyCreate
  ${If} ${UAC_IsInnerInstance}
  ${AndIf} ${UAC_IsAdmin}
    Abort
  ${EndIf}
  ${If} $VarinIsUpgrade == "1"
    !insertmacro VarinPageHeader "$(VarinUpdateTitle)" "$(VarinUpdateSubtitle)"
  ${Else}
    !insertmacro VarinPageHeader "$(VarinInstallTitle)" "$(VarinInstallSubtitle)"
  ${EndIf}
  ${NSD_CreateLabel} 0 39% 100% 7% "$(VarinLocation)"
  Pop $0
  ${NSD_CreateText} 0 47% 78% 9% "$INSTDIR"
  Pop $VarinDirectoryInput
  ${NSD_CreateLabel} 0 47% 100% 9% "$INSTDIR"
  Pop $VarinDirectoryLabel
  ${NSD_CreateBrowseButton} 81% 47% 19% 9% "$(VarinBrowse)"
  Pop $VarinBrowseButton
  ${NSD_OnClick} $VarinBrowseButton VarinDirectoryBrowse
  ${NSD_CreateCheckbox} 0 59% 100% 9% "$(VarinShortcut)"
  Pop $VarinShortcutControl
  ${NSD_SetState} $VarinShortcutControl $VarinShortcut
  ${NSD_CreateButton} 0 71% 29% 9% "$(VarinOptions)"
  Pop $VarinOptionsButton
  ${NSD_OnClick} $VarinOptionsButton VarinToggleOptions
  ${NSD_CreateButton} 69% 71% 31% 9% "$(VarinLicense)"
  Pop $0
  ${NSD_OnClick} $0 VarinLicense
  ${NSD_CreateRadioButton} 0 82% 100% 8% "$(VarinCurrentUser)"
  Pop $VarinScopeControl
  ${NSD_CreateRadioButton} 0 92% 100% 8% "$(VarinAllUsers)"
  Pop $VarinAllUsersControl
  ${NSD_OnClick} $VarinScopeControl VarinScopeChanged
  ${NSD_OnClick} $VarinAllUsersControl VarinScopeChanged
  ${If} $installMode == "all"
    ${NSD_SetState} $VarinAllUsersControl ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $VarinScopeControl ${BST_CHECKED}
  ${EndIf}
  ShowWindow $VarinScopeControl ${SW_HIDE}
  ShowWindow $VarinAllUsersControl ${SW_HIDE}
  Call VarinStylePage
  Call VarinReadyState
  nsDialogs::Show
FunctionEnd
Function VarinReadyLeave
  ${NSD_GetText} $VarinDirectoryInput $INSTDIR
  ${GetRoot} "$INSTDIR" $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION "$(VarinPathError)"
    Abort
  ${EndIf}
  ${If} $VarinIsUpgrade != "1"
    Call VarinResolveInstallDirectory
    ${NSD_GetState} $VarinShortcutControl $VarinShortcut
  ${EndIf}
  StrCpy $VarinDesiredDirectory "$INSTDIR"
  ${If} $installMode == "all"
  ${AndIfNot} ${UAC_IsAdmin}
    ShowWindow $HWNDPARENT ${SW_HIDE}
    !insertmacro UAC_RunElevated
    ${If} $0 == 0
    ${AndIf} $1 == 1
      Quit
    ${EndIf}
    ShowWindow $HWNDPARENT ${SW_SHOW}
    BringToFront
    ${If} $0 != 1223
      MessageBox MB_ICONEXCLAMATION "$(VarinElevationError)"
    ${EndIf}
    Abort
  ${EndIf}
FunctionEnd
Function VarinFinishCreate
  !insertmacro VarinPageHeader "$(VarinReady)" "$(VarinReadySubtitle)"
  ${If} $VarinIsUpgrade == "1"
    ${NSD_SetText} $VarinTitle "$(VarinUpdated)"
  ${EndIf}
  Call VarinStylePage
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinOpen)"
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinFinish)"
  nsDialogs::Show
FunctionEnd
Function VarinFinishLeave
  ${If} ${isUpdated}
    StrCpy $1 "--updated"
  ${Else}
    StrCpy $1 ""
  ${EndIf}
  ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
FunctionEnd
!macroend
!endif
