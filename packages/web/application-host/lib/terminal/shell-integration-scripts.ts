/* eslint-disable no-useless-escape -- bash/zsh templates must emit $ and ${} */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASH_SCRIPT = `if [ -n "\${VARIN_SHELL_INTEGRATION:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
export VARIN_SHELL_INTEGRATION=1

if ! shopt -q login_shell 2>/dev/null; then
  [ -f /etc/bash.bashrc ] && . /etc/bash.bashrc
  [ -f "\$HOME/.bashrc" ] && . "\$HOME/.bashrc"
fi

__varin_escape() {
  printf '%s' "\$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/;/\\\\x3b/g'
}

__varin_emit() {
  printf '\\033]633;pi;%s;%s\\007' "\${VARIN_SHELL_INTEGRATION_ID:-}" "\$1"
}

__varin_awaiting=
__varin_prompt_command() {
  local __varin_status=\$?
  if [ -n "\$__varin_awaiting" ]; then
    local __varin_cmd
    __varin_cmd=\$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9][0-9]* *//')
    if [ -n "\$__varin_cmd" ]; then
      __varin_emit "E;\$(__varin_escape "\$__varin_cmd")"
    fi
    __varin_emit "D;\$__varin_status"
    __varin_awaiting=
  fi
  __varin_emit "P;Cwd=\$(__varin_escape "\$PWD")"
  __varin_emit "A"
}

__varin_debug_trap() {
  [ -n "\${COMP_LINE:-}" ] && return
  [ -n "\$__varin_awaiting" ] && return
  case "\$BASH_COMMAND" in
    __varin_prompt_command*|__varin_debug_trap*) return ;;
  esac
  __varin_awaiting=1
  __varin_emit "C"
}

if declare -p PROMPT_COMMAND >/dev/null 2>&1; then
  if [[ "\$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__varin_prompt_command "\${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="__varin_prompt_command; \${PROMPT_COMMAND}"
  fi
else
  PROMPT_COMMAND="__varin_prompt_command"
fi

__varin_prev_debug=
__varin_trap_debug=\$(trap -p DEBUG 2>/dev/null || true)
if [ -n "\$__varin_trap_debug" ]; then
  __varin_prev_debug=\${__varin_trap_debug#trap -- \\'}
  __varin_prev_debug=\${__varin_prev_debug%\\' DEBUG}
fi
if [ -n "\$__varin_prev_debug" ]; then
  trap '__varin_debug_trap; eval "\$__varin_prev_debug"' DEBUG
else
  trap '__varin_debug_trap' DEBUG
fi
`;

export const POWERSHELL_COMMAND_START_CAPTURE = `$global:__VarinNativeExitBaseline = $global:LASTEXITCODE
  $global:__VarinNativeExitBaselineSet = $true`;

export const POWERSHELL_EXIT_CAPTURE = `$__varin_success = $?
  $__varin_exit = $global:LASTEXITCODE
  $__varin_native_status_observed = $false
  if ($global:__VarinNativeExitBaselineSet -eq $true) {
    $__varin_native_status_observed = if ($__varin_exit -is [int]) {
      if ($global:__VarinNativeExitBaseline -is [int]) {
        [int]$__varin_exit -ne [int]$global:__VarinNativeExitBaseline
      } else {
        $true
      }
    } else {
      $false
    }
  }
  # LASTEXITCODE has no generation counter. A changed native status proves
  # that this command ran a native process; an unchanged value is explicitly
  # treated as unknown and falls back to cmdlet success/failure semantics.
  $code = if ($__varin_success) { 0 } elseif ($__varin_native_status_observed) { [int]$__varin_exit } else { 1 }
  $global:__VarinNativeExitBaseline = $__varin_exit
  $global:__VarinNativeExitBaselineSet = $true`;

const POWERSHELL_SCRIPT = `if ($env:VARIN_SHELL_INTEGRATION) { return }
$env:VARIN_SHELL_INTEGRATION = '1'

function global:__VarinEscape([string]$Value) {
  return (($Value -replace '\\\\', '\\\\\\\\') -replace ';', '\\x3b')
}

function global:__VarinEmit([string]$Payload) {
  # Windows PowerShell 5.1 treats backtick-e as the literal letter e.
  [Console]::Write(([string][char]0x1b + "]633;pi;" + $env:VARIN_SHELL_INTEGRATION_ID + ";" + $Payload + [char]0x07))
}

$__VarinOriginalPrompt = $function:prompt
function global:prompt {
  ${POWERSHELL_EXIT_CAPTURE}
  if ($global:__VarinAwaitingFinish) {
    __VarinEmit ("D;" + $code)
    $global:__VarinAwaitingFinish = $false
  }
  __VarinEmit ("P;Cwd=" + (__VarinEscape $PWD.Path))
  __VarinEmit 'A'
  if ($__VarinOriginalPrompt) { & $__VarinOriginalPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
}

if (Get-Module -ListAvailable -Name PSReadLine) {
  Import-Module PSReadLine -ErrorAction SilentlyContinue
  $__VarinPreviousHistoryHandler = (Get-PSReadLineOption).AddToHistoryHandler
  Set-PSReadLineOption -AddToHistoryHandler {
    param($line)
    if ($line) {
      ${POWERSHELL_COMMAND_START_CAPTURE}
      __VarinEmit ("E;" + (__VarinEscape $line))
      __VarinEmit 'C'
      $global:__VarinAwaitingFinish = $true
    }
    if ($__VarinPreviousHistoryHandler) {
      return & $__VarinPreviousHistoryHandler $line
    }
    $true
  }
}
`;

const zshUserZdot = `"\${VARIN_USER_ZDOTDIR:-\$HOME}"`;
const zshUserZdotSet = `"\${VARIN_USER_ZDOTDIR_SET:-0}"`;

const ZSH_ENV_SCRIPT = `__varin_user_zdotdir=${zshUserZdot}
__varin_user_zdotdir_set=${zshUserZdotSet}
if [ -f "\$__varin_user_zdotdir/.zshenv" ]; then
  if [ "\$__varin_user_zdotdir_set" = 1 ]; then ZDOTDIR="\$__varin_user_zdotdir"; else unset ZDOTDIR; fi
  . "\$__varin_user_zdotdir/.zshenv"
fi
ZDOTDIR="\${VARIN_ZDOTDIR:-\$ZDOTDIR}"
`;

const ZSH_PROFILE_SCRIPT = `__varin_user_zdotdir=${zshUserZdot}
__varin_user_zdotdir_set=${zshUserZdotSet}
if [ -f "\$__varin_user_zdotdir/.zprofile" ]; then
  if [ "\$__varin_user_zdotdir_set" = 1 ]; then ZDOTDIR="\$__varin_user_zdotdir"; else unset ZDOTDIR; fi
  . "\$__varin_user_zdotdir/.zprofile"
fi
ZDOTDIR="\${VARIN_ZDOTDIR:-\$ZDOTDIR}"
`;

const ZSH_LOGIN_SCRIPT = `__varin_user_zdotdir=${zshUserZdot}
__varin_user_zdotdir_set=${zshUserZdotSet}
if [ -f "\$__varin_user_zdotdir/.zlogin" ]; then
  if [ "\$__varin_user_zdotdir_set" = 1 ]; then ZDOTDIR="\$__varin_user_zdotdir"; else unset ZDOTDIR; fi
  . "\$__varin_user_zdotdir/.zlogin"
fi
ZDOTDIR="\${VARIN_ZDOTDIR:-\$ZDOTDIR}"
`;

const ZSH_SCRIPT = `if [ -n "\${VARIN_SHELL_INTEGRATION:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
export VARIN_SHELL_INTEGRATION=1
__varin_user_zdotdir=${zshUserZdot}
__varin_user_zdotdir_set=${zshUserZdotSet}
[ -f /etc/zshrc ] && . /etc/zshrc
if [ -f "\$__varin_user_zdotdir/.zshrc" ]; then
  if [ "\$__varin_user_zdotdir_set" = 1 ]; then ZDOTDIR="\$__varin_user_zdotdir"; else unset ZDOTDIR; fi
  . "\$__varin_user_zdotdir/.zshrc"
  ZDOTDIR="\${VARIN_ZDOTDIR:-\$ZDOTDIR}"
fi

__varin_escape() {
  printf '%s' "\$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/;/\\\\x3b/g'
}

__varin_emit() {
  printf '\\033]633;pi;%s;%s\\007' "\${VARIN_SHELL_INTEGRATION_ID:-}" "\$1"
}

__varin_preexec() {
  __varin_emit "E;\$(__varin_escape "\$1")"
  __varin_emit "C"
}

__varin_precmd() {
  __varin_emit "D;\$?"
  __varin_emit "P;Cwd=\$(__varin_escape "\$PWD")"
  __varin_emit "A"
}

autoload -Uz add-zsh-hook 2>/dev/null || true
if typeset -f add-zsh-hook >/dev/null 2>&1; then
  add-zsh-hook preexec __varin_preexec
  add-zsh-hook precmd __varin_precmd
fi
`;

const scriptPath = (name: string, contents: string, encoding: BufferEncoding = "utf8"): string => {
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), "varin-shell-integration");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}-${hash}${name === "powershell" ? ".ps1" : ".sh"}`);
  writeFileSync(file, contents, { encoding });
  return file;
};

export type ShellIntegrationFamily = "bash" | "powershell" | "zsh";

export const shellIntegrationFamily = (executable: string): ShellIntegrationFamily | null => {
  const name = executable.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const id = name.endsWith(".exe") ? name.slice(0, -4) : name;
  if (id === "bash") return "bash";
  if (id === "zsh") return "zsh";
  if (id === "pwsh" || id === "powershell") return "powershell";
  return null;
};

const materializeZshDotDir = (): string => {
  const hash = createHash("sha256")
    .update(ZSH_ENV_SCRIPT)
    .update(ZSH_PROFILE_SCRIPT)
    .update(ZSH_SCRIPT)
    .update(ZSH_LOGIN_SCRIPT)
    .digest("hex")
    .slice(0, 16);
  const directory = join(tmpdir(), "varin-shell-integration", `zsh-${hash}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, ".zshenv"), ZSH_ENV_SCRIPT);
  writeFileSync(join(directory, ".zprofile"), ZSH_PROFILE_SCRIPT);
  writeFileSync(join(directory, ".zshrc"), ZSH_SCRIPT);
  writeFileSync(join(directory, ".zlogin"), ZSH_LOGIN_SCRIPT);
  return directory;
};

export const materializeShellIntegrationScript = (family: ShellIntegrationFamily): string => {
  if (family === "powershell") return scriptPath("powershell", `\ufeff${POWERSHELL_SCRIPT}`, "utf8");
  if (family === "zsh") return join(materializeZshDotDir(), ".zshrc");
  return scriptPath("bash", BASH_SCRIPT);
};

export const shellIntegrationLaunch = (
  executable: string,
  baseArgs: readonly string[],
  loginShell: boolean,
  integrationId: string,
): { args: string[]; env: Record<string, string> } | null => {
  const family = shellIntegrationFamily(executable);
  if (!family) return null;
  const userZdotDir = process.env.ZDOTDIR;
  const env: Record<string, string> = {
    VARIN_SHELL_INTEGRATION_KIND: family,
    VARIN_SHELL_INTEGRATION_ID: integrationId,
    ...(loginShell ? { VARIN_LOGIN_SHELL: "1" } : {}),
  };
  if (family === "powershell") {
    return {
      args: [...baseArgs, "-NoExit", "-ExecutionPolicy", "Bypass", "-File", materializeShellIntegrationScript(family)],
      env,
    };
  }
  if (family === "zsh") {
    const zdotdir = materializeZshDotDir();
    return {
      args: [...baseArgs],
      env: {
        ...env,
        ZDOTDIR: zdotdir,
        VARIN_ZDOTDIR: zdotdir,
        VARIN_USER_ZDOTDIR_SET: userZdotDir === undefined ? "0" : "1",
        ...(userZdotDir === undefined ? {} : { VARIN_USER_ZDOTDIR: userZdotDir }),
      },
    };
  }
  return {
    args: [...baseArgs, "--init-file", materializeShellIntegrationScript(family)],
    env,
  };
};
