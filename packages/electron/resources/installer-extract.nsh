!ifndef VARIN_INSTALLER_EXTRACT_INCLUDED
!define VARIN_INSTALLER_EXTRACT_INCLUDED

Var VarinProgressBar
Var VarinProgressStatus
!ifndef BUILD_UNINSTALLER
  !define /ifndef VARIN_INSTALLER_UI_DIR "${__FILEDIR__}\installer-tools"
  !define /ifndef VARIN_EXTRACT_LABEL "Extracting application files"
  !addplugindir /x86-unicode "${VARIN_INSTALLER_UI_DIR}"
  !ifndef VARIN_INSTALLER_7ZA
    !define VARIN_INSTALLER_7ZA "${__FILEDIR__}\installer-tools\7za.exe"
  !endif

  ; Keep electron-builder's archive, update cache and uninstall lifecycle. Only
  ; replace the old decoder + temporary-tree copy with one checked extraction.
  !macro customExtractUsing7za FILE
    InitPluginsDir
    File "/oname=$PLUGINSDIR\varin-7za.exe" "${VARIN_INSTALLER_7ZA}"
    Push "${FILE}"
    Call VarinExtractInstallerPayload
  !macroend

  Function VarinExtractInstallerPayload
    Exch $R1
    Push $R0
    Push $R2
  varin_extract_retry:
    VarinSetup::Extract "$PLUGINSDIR\varin-7za.exe" "$R1" "$OUTDIR" "$VarinProgressBar" "$VarinProgressStatus" "${VARIN_EXTRACT_LABEL}"
    Pop $R0
    Pop $R2
    StrCmp $R0 "0" varin_extract_done
    ; A failed decode must not become an apparently successful installation.
    ; Interactive installs can retry after freeing space or closing a file.
    IfSilent varin_extract_failed
    !ifdef VARIN_EXTRACT_INLINE_RETRY
      VarinSetup::Retry "$VarinProgressPage" "$(VarinInstallFailed)" "$(decompressionFailed)$\r$\n$R2" "$(VarinRetryInstall)" "$(VarinExit)"
      Pop $R0
      StrCmp "$R0" "retry" varin_extract_retry
    !else
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(decompressionFailed)$\r$\n$R2" IDRETRY varin_extract_retry
    !endif
  varin_extract_failed:
    SetErrorLevel 2
    Quit
  varin_extract_done:
    !ifdef VARIN_FINALIZE_LABEL
      SendMessage $VarinProgressBar ${PBM_SETMARQUEE} 1 0
      GetDlgItem $R2 $VarinProgressPage 9002
      SendMessage $R2 ${WM_SETTEXT} 0 "STR:${VARIN_FINALIZE_LABEL}"
      SendMessage $VarinProgressStatus ${WM_SETTEXT} 0 "STR:"
    !endif
    Pop $R2
    Pop $R0
    Pop $R1
  FunctionEnd
!endif
!endif
