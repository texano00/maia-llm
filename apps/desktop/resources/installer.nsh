; Maia LLM NSIS customisation.
;
; Goals:
;   * Detect a previous Maia LLM installation, whatever version or product name
;     created it, and update it in place instead of adding a second copy.
;   * Ask the operator before writing files, so an upgrade is never a surprise.
;   * Force a per-user install so the assisted installer needs no elevation and
;     shows no install-mode or directory pages.
;
; electron-builder includes this script in both the installer and the
; uninstaller, and NSIS substitutes defines at macro insertion time, so
; INSTALL_REGISTRY_KEY / APP_EXECUTABLE_FILENAME are already defined where the
; macros below are expanded (inside .onInit and the install-mode page).

!include "LogicLib.nsh"

; The uninstaller pass compiles this header too, but it never runs customInit,
; so keep the variables and the macro out of that build to avoid "never set"
; warnings (electron-builder treats NSIS warnings as errors).
!ifndef BUILD_UNINSTALLER
  Var MaiaPreviousInstallDir
  Var MaiaPreviousVersion

  !macro customInit
    StrCpy $MaiaPreviousInstallDir ""
    StrCpy $MaiaPreviousVersion ""

    ; electron-builder records both values for the active shell context
    ; (HKCU for per-user, HKLM for per-machine), so one read covers upgrades of
    ; any earlier build that used the same application id.
    ReadRegStr $MaiaPreviousInstallDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $MaiaPreviousVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"

    ${If} $MaiaPreviousInstallDir != ""
    ${AndIf} ${FileExists} "$MaiaPreviousInstallDir\${APP_EXECUTABLE_FILENAME}"
      ; Reuse the existing folder: this turns the run into an in-place update and
      ; keeps the uninstall entry, shortcuts and user data intact.
      StrCpy $INSTDIR "$MaiaPreviousInstallDir"

      ${IfNot} ${Silent}
        MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Maia LLM ${VERSION} will update the existing installation in:$\r$\n$\r$\n$MaiaPreviousInstallDir$\r$\n$\r$\nInstalled version: $MaiaPreviousVersion$\r$\nYour chats and settings are kept.$\r$\n$\r$\nContinue with the update?" IDOK maia_update_confirmed
        Quit
        maia_update_confirmed:
      ${EndIf}
    ${EndIf}
  !macroend
!endif

; Removing the install-mode page (per-user vs all users) keeps the flow to a
; single "Install" step. $isForceCurrentInstall is read by multiUserUi.nsh
; before the page is shown and makes it abort.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
  ; electron-builder's default finish page launches the app through
  ; ${StdUtils.ExecShellAsUser}, which duplicates a shell token and blocks the
  ; wizard for several seconds after "Finish" is clicked. This installer is
  ; per-user (same token, no elevation), so a plain Exec is immediate.
  !macro customFinishPage
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_TEXT "Launch Maia LLM"
    !define MUI_FINISHPAGE_RUN_FUNCTION "MaiaLaunchApp"
    !insertmacro MUI_PAGE_FINISH

    Function MaiaLaunchApp
      ${If} ${isUpdated}
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
      ${Else}
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
      ${EndIf}
    FunctionEnd
  !macroend
!endif
