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
    Call VarinReadyState
  ${EndIf}
FunctionEnd
Function VarinToggleOptions
  Pop $0
  ${If} $VarinOptionsOpen == "0"
    StrCpy $VarinOptionsOpen "1"
  ${Else}
    StrCpy $VarinOptionsOpen "0"
  ${EndIf}
  Call VarinReadyState
  System::Call 'user32::SetFocus(p $VarinOptionsButton)'
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
  ; Apply the current selection before changing the layout; collapsing never
  ; discards an edited path or changes the selected installation scope.
  ${NSD_GetText} $VarinDirectoryInput $INSTDIR
  StrCpy $VarinIsUpgrade "0"
  GetDlgItem $0 $HWNDPARENT 1
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $VarinIsUpgrade "1"
    ${NSD_SetText} $VarinHeroTitle "$(VarinUpdateTitle)"
    ${NSD_SetText} $VarinHeroSubtitle "$(VarinUpdateSubtitle)"
    ${NSD_SetText} $VarinDirectoryLabel "$INSTDIR"
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinUpdate)"
    StrCpy $VarinProgressTitle "$(VarinUpdating)"
  ${Else}
    ${NSD_SetText} $VarinHeroTitle "$(VarinInstallTitle)"
    ${NSD_SetText} $VarinHeroSubtitle "$(VarinInstallSubtitle)"
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinInstall)"
    StrCpy $VarinProgressTitle "$(VarinInstalling)"
  ${EndIf}
  ${If} $VarinOptionsOpen == "1"
    StrCpy $VarinScene "standard"
    ${NSD_SetText} $VarinOptionsButton "$(VarinCloseOptions)"
    ShowWindow $VarinHeroTitle ${SW_HIDE}
    ShowWindow $VarinHeroSubtitle ${SW_HIDE}
    ShowWindow $VarinTitle ${SW_SHOW}
    ShowWindow $VarinLocationControl ${SW_SHOW}
    ShowWindow $VarinScopeControl ${SW_SHOW}
    ShowWindow $VarinAllUsersControl ${SW_SHOW}
    ShowWindow $VarinLicenseControl ${SW_SHOW}
    ${If} $VarinIsUpgrade == "1"
      ShowWindow $VarinDirectoryInput ${SW_HIDE}
      ShowWindow $VarinDirectoryLabel ${SW_SHOW}
      ShowWindow $VarinBrowseButton ${SW_HIDE}
      ShowWindow $VarinShortcutControl ${SW_HIDE}
    ${Else}
      ShowWindow $VarinDirectoryInput ${SW_SHOW}
      ShowWindow $VarinDirectoryLabel ${SW_HIDE}
      ShowWindow $VarinBrowseButton ${SW_SHOW}
      ShowWindow $VarinShortcutControl ${SW_SHOW}
    ${EndIf}
  ${Else}
    StrCpy $VarinScene "hero"
    ${NSD_SetText} $VarinOptionsButton "$(VarinOptions)"
    ShowWindow $VarinHeroTitle ${SW_SHOW}
    ShowWindow $VarinHeroSubtitle ${SW_SHOW}
    ShowWindow $VarinTitle ${SW_HIDE}
    ShowWindow $VarinLocationControl ${SW_HIDE}
    ShowWindow $VarinDirectoryInput ${SW_HIDE}
    ShowWindow $VarinDirectoryLabel ${SW_HIDE}
    ShowWindow $VarinBrowseButton ${SW_HIDE}
    ShowWindow $VarinShortcutControl ${SW_HIDE}
    ShowWindow $VarinScopeControl ${SW_HIDE}
    ShowWindow $VarinAllUsersControl ${SW_HIDE}
    ShowWindow $VarinLicenseControl ${SW_HIDE}
  ${EndIf}
  VarinSetup::Page "$VarinPage" "$VarinScene"
  VarinSetup::TextStyle "$VarinTitle" "title"
  VarinSetup::TextStyle "$VarinHeroTitle" "center"
  VarinSetup::TextStyle "$VarinHeroSubtitle" "muted-center"
  VarinSetup::TextStyle "$VarinLocationControl" "muted"
  VarinSetup::TextStyle "$VarinDirectoryLabel" "muted"
FunctionEnd
Function VarinReadyCreate
  ${If} ${UAC_IsInnerInstance}
  ${AndIf} ${UAC_IsAdmin}
    Abort
  ${EndIf}
  !insertmacro VarinPageHeader "$(VarinOptions)" ""
  ShowWindow $VarinSubtitle ${SW_HIDE}
  ${NSD_CreateLabel} 0 61% 100% 8% "$(VarinInstallTitle)"
  Pop $VarinHeroTitle
  ${NSD_CreateLabel} 0 71% 100% 8% "$(VarinInstallSubtitle)"
  Pop $VarinHeroSubtitle
  ${NSD_CreateLabel} 0 30% 100% 7% "$(VarinLocation)"
  Pop $VarinLocationControl
  ${NSD_CreateText} 0 38% 78% 9% "$INSTDIR"
  Pop $VarinDirectoryInput
  ${NSD_CreateLabel} 0 38% 100% 9% "$INSTDIR"
  Pop $VarinDirectoryLabel
  ${NSD_CreateBrowseButton} 81% 38% 19% 9% "$(VarinBrowse)"
  Pop $VarinBrowseButton
  ${NSD_OnClick} $VarinBrowseButton VarinDirectoryBrowse
  ${NSD_CreateCheckbox} 0 50% 100% 9% "$(VarinShortcut)"
  Pop $VarinShortcutControl
  ${NSD_SetState} $VarinShortcutControl $VarinShortcut
  ${NSD_CreateButton} 25% 89% 50% 9% "$(VarinOptions)"
  Pop $VarinOptionsButton
  ${NSD_OnClick} $VarinOptionsButton VarinToggleOptions
  VarinSetup::Link "$VarinOptionsButton"
  ${NSD_CreateButton} 0 79% 29% 8% "$(VarinLicense)"
  Pop $VarinLicenseControl
  ${NSD_OnClick} $VarinLicenseControl VarinLicense
  VarinSetup::Link "$VarinLicenseControl"
  ${NSD_CreateRadioButton} 0 61% 100% 8% "$(VarinCurrentUser)"
  Pop $VarinScopeControl
  ${NSD_CreateRadioButton} 0 70% 100% 8% "$(VarinAllUsers)"
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
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'user32::SetFocus(p $0)'
  nsDialogs::Show
FunctionEnd
Function VarinReadyLeave
  Call VarinReadyState
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
  nsDialogs::Create 1018
  Pop $VarinPage
  ${If} $VarinPage == error
    Abort
  ${EndIf}
  StrCpy $VarinScene "hero"
  ${NSD_CreateLabel} 0 61% 100% 8% "$(VarinReady)"
  Pop $VarinTitle
  ${NSD_CreateLabel} 0 71% 100% 8% "$(VarinReadySubtitle)"
  Pop $VarinSubtitle
  ${If} $VarinIsUpgrade == "1"
    ${NSD_SetText} $VarinTitle "$(VarinUpdated)"
  ${EndIf}
  Call VarinStylePage
  VarinSetup::TextStyle "$VarinTitle" "center"
  VarinSetup::TextStyle "$VarinSubtitle" "muted-center"
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinOpen)"
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
  EnableWindow $0 1
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
