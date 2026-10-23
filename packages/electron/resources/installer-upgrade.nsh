!ifndef BUILD_UNINSTALLER
Var VarinUpgradeDirectory
Var VarinUpgradeArguments
Var VarinUpgradeResult
Var VarinUpgradeDetail
Var VarinUpgradeFile
Var VarinUpgradeLine

; Run this package's remover for the registered installation. Reusing the old
; embedded remover would also reuse its broken long-path/cross-volume moves.
!macro customUninstallOldVersion DIRECTORY ARGUMENTS RESULT
  StrCpy $VarinUpgradeDirectory "${DIRECTORY}"
  StrCpy $VarinUpgradeArguments "${ARGUMENTS}"
  File "/oname=$PLUGINSDIR\varin-upgrade-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"
  Call VarinRemovePreviousVersion
  StrCpy ${RESULT} $VarinUpgradeResult
!macroend

Function VarinRemovePreviousVersion
  SetDetailsPrint both
  DetailPrint "$(VarinRemovingPrevious) $VarinUpgradeDirectory"
  GetDlgItem $VarinUpgradeFile $VarinProgressPage 9002
  SendMessage $VarinUpgradeFile ${WM_SETTEXT} 0 "STR:$(VarinRemovingPrevious)"
  SendMessage $VarinProgressBar ${PBM_SETMARQUEE} 1 0
varin_upgrade_retry:
  Delete "$PLUGINSDIR\varin-removal.txt"
  StrCpy $VarinUpgradeDetail "$(VarinRemoveFailed)$\r$\n$VarinUpgradeDirectory"
  ClearErrors
  ExecWait '"$PLUGINSDIR\varin-upgrade-uninstaller.exe" /S /KEEP_APP_DATA $VarinUpgradeArguments "--varin-removal-result=$PLUGINSDIR\varin-removal.txt" _?=$VarinUpgradeDirectory' $VarinUpgradeResult
  ${If} ${Errors}
    StrCpy $VarinUpgradeResult "2"
  ${EndIf}
  ${If} $VarinUpgradeResult == "0"
    ClearErrors
    Return
  ${EndIf}
  FileOpen $VarinUpgradeFile "$PLUGINSDIR\varin-removal.txt" r
  ${IfNot} ${Errors}
    StrCpy $VarinUpgradeDetail ""
    ${Do}
      FileReadUTF16LE $VarinUpgradeFile $VarinUpgradeLine
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      StrCpy $VarinUpgradeDetail "$VarinUpgradeDetail$VarinUpgradeLine"
    ${Loop}
    FileClose $VarinUpgradeFile
  ${EndIf}
  DetailPrint "$VarinUpgradeDetail"
  IfSilent varin_upgrade_failed
  VarinSetup::Retry "$VarinProgressPage" "$(VarinRemoveFailed)" "$VarinUpgradeDetail" "$(VarinRetryInstall)" "$(VarinExit)"
  Pop $VarinUpgradeResult
  StrCmp "$VarinUpgradeResult" "retry" varin_upgrade_retry
varin_upgrade_failed:
  SetErrorLevel 2
  Quit
FunctionEnd
!endif
