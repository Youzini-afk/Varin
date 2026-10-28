!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "UAC.nsh"
!include "${__FILEDIR__}\installer-tools\installer-generated.nsh"
!addplugindir /x86-unicode "${__FILEDIR__}\installer-tools"
!define VARIN_EXTRACT_LABEL "$(VarinExtracting)"
!define VARIN_FINALIZE_LABEL "$(VarinFinalizing)"
!define VARIN_EXTRACT_INLINE_RETRY

Var VarinPage
Var VarinTitle
Var VarinSubtitle
Var VarinScene
!ifndef BUILD_UNINSTALLER
Var VarinDirectoryInput
Var VarinDirectoryLabel
Var VarinLocationControl
Var VarinLicenseControl
Var VarinHeroTitle
Var VarinHeroSubtitle
Var VarinBrowseButton
Var VarinShortcutControl
Var VarinShortcut
Var VarinScopeControl
Var VarinAllUsersControl
Var VarinOptionsButton
Var VarinOptionsOpen
Var VarinDesiredDirectory
Var VarinIsUpgrade
!else
Var VarinRemoveData
Var VarinDataControl
Var VarinDataWarning
Var VarinRetentionTitle
Var VarinRetentionText
Var VarinUserData
Var VarinDataFailed
!endif
Var VarinTheme
Var VarinBackground
Var VarinForeground
Var VarinMuted
Var VarinSurface
Var VarinPrimary
Var VarinOnPrimary
Var VarinTitleFont
Var VarinProgressPage
Var VarinProgressTitle
Var VarinProgressDescription
!include "${__FILEDIR__}\installer-extract.nsh"

!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT VarinGuiInit
!else
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.VarinGuiInit
!endif
!macro customHeader
  AutoCloseWindow true
  BrandingText " "
  Caption "${PRODUCT_NAME}"
  UninstallCaption "${PRODUCT_NAME}"
  SetFont "Segoe UI" 10
!macroend

; Retain the existing CLI switch and add the user's explicit checkbox choice.
!ifndef BUILD_UNINSTALLER
!macro _VarinNoDesktop _a _b _t _f
  StrCmp "$VarinShortcut" "0" `${_t}`
  ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!undef isNoDesktopShortcut
!define isNoDesktopShortcut `"" VarinNoDesktop ""`
!endif

!macro VarinThemeFunctions PREFIX
  Function ${PREFIX}VarinGuiInit
    ; AutoCloseWindow only sets the installer default. The uninstaller needs
    ; its runtime flag too, so instfiles advances to our custom finish page.
    SetAutoClose true
    ClearErrors
    ReadRegDWORD $VarinTheme HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
    ${If} ${Errors}
      StrCpy $VarinTheme "1"
    ${EndIf}
    ${If} $VarinTheme == "0"
      StrCpy $VarinBackground "${VARIN_DARK_BACKGROUND}"
      StrCpy $VarinForeground "${VARIN_DARK_FOREGROUND}"
      StrCpy $VarinMuted "${VARIN_DARK_MUTED}"
      StrCpy $VarinSurface "${VARIN_DARK_SURFACE}"
      StrCpy $VarinPrimary "${VARIN_DARK_PRIMARY}"
      StrCpy $VarinOnPrimary "${VARIN_DARK_ON_PRIMARY}"
    ${Else}
      StrCpy $VarinBackground "${VARIN_LIGHT_BACKGROUND}"
      StrCpy $VarinForeground "${VARIN_LIGHT_FOREGROUND}"
      StrCpy $VarinMuted "${VARIN_LIGHT_MUTED}"
      StrCpy $VarinSurface "${VARIN_LIGHT_SURFACE}"
      StrCpy $VarinPrimary "${VARIN_LIGHT_PRIMARY}"
      StrCpy $VarinOnPrimary "${VARIN_LIGHT_ON_PRIMARY}"
    ${EndIf}
    !if "${PREFIX}" == "un."
      VarinSetup::Theme "$VarinBackground" "$VarinForeground" "$VarinMuted" "$VarinSurface" "$VarinPrimary" "$VarinOnPrimary" "${VERSION} · Windows" "${APP_ID}.uninstall" "$(VarinUninstallTitle)" "$INSTDIR\${UNINSTALL_FILENAME}"
    !else
      VarinSetup::Theme "$VarinBackground" "$VarinForeground" "$VarinMuted" "$VarinSurface" "$VarinPrimary" "$VarinOnPrimary" "${VERSION} · Windows" "${APP_ID}.setup" "${PRODUCT_NAME}" "$EXEPATH"
    !endif
    CreateFont $VarinTitleFont "Segoe UI" 18 500
  FunctionEnd
  Function ${PREFIX}VarinStylePage
    VarinSetup::Page "$VarinPage" "$VarinScene"
    VarinSetup::TextStyle "$VarinTitle" "title"
    VarinSetup::TextStyle "$VarinSubtitle" "muted"
    GetDlgItem $0 $HWNDPARENT 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VarinCancel)"
  FunctionEnd
  Function ${PREFIX}VarinProgressShow
    FindWindow $VarinProgressPage "#32770" "" $HWNDPARENT
    GetDlgItem $VarinProgressBar $VarinProgressPage 1004
    GetDlgItem $VarinProgressStatus $VarinProgressPage 1006
    !if "${PREFIX}" == "un."
      VarinSetup::Progress "$VarinProgressPage" "$VarinProgressTitle" "$VarinProgressDescription" "$(VarinDetails)" "uninstall"
    !else
      VarinSetup::Progress "$VarinProgressPage" "$VarinProgressTitle" "$VarinProgressDescription" "$(VarinDetails)" "install"
    !endif
  FunctionEnd
  Function ${PREFIX}VarinProgressLeave
    ; Stop the custom timer on both success and abort, before NSIS leaves or
    ; retains the instfiles page. Completion is owned by NSIS, not bar position.
    SendMessage $VarinProgressBar ${PBM_SETMARQUEE} 0 0
  FunctionEnd
!macroend

!macro VarinPageHeader TITLE SUBTITLE
  StrCpy $VarinScene "standard"
  nsDialogs::Create 1018
  Pop $VarinPage
  ${If} $VarinPage == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 17% 100% 12% "${TITLE}"
  Pop $VarinTitle
  ${NSD_CreateLabel} 0 29% 100% 10% "${SUBTITLE}"
  Pop $VarinSubtitle
!macroend

!include "${__FILEDIR__}\installer-install.nsh"
!include "${__FILEDIR__}\installer-uninstall.nsh"
!include "${__FILEDIR__}\installer-upgrade.nsh"
!include "${__FILEDIR__}\installer-workspace.nsh"
!macro customAssistedPages
  !ifndef BUILD_UNINSTALLER
    !insertmacro VarinThemeFunctions ""
    !insertmacro VarinInstallFunctions
    Page custom VarinReadyCreate VarinReadyLeave
    !insertmacro VarinWorkspaceFunctions
    Page custom VarinWorkspaceCreate VarinWorkspaceLeave
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW VarinProgressShow
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE VarinProgressLeave
    !insertmacro MUI_PAGE_INSTFILES
    Page custom VarinFinishCreate VarinFinishLeave
  !else
    !insertmacro VarinThemeFunctions "un."
    !insertmacro VarinUninstallFunctions
    ; Only dual user/machine installations need the existing selection page.
    !insertmacro PAGE_INSTALL_MODE
    UninstPage custom un.VarinReadyCreate un.VarinReadyLeave
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.VarinProgressShow
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.VarinProgressLeave
    !insertmacro MUI_UNPAGE_INSTFILES
    UninstPage custom un.VarinFinishCreate
  !endif
!macroend
