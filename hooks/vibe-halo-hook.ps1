# Vibe Halo hook launcher for Windows clients that run hooks through Git Bash.
# It is invoked as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <this file> ...`,
# which behaves the same under Git Bash, cmd.exe and PowerShell (no `cmd /c` switches to be rewritten).
# The hook process inherits this console's stdin/stdout, so the client's JSON reaches vibe-halo-hook.js
# unchanged and only the sanitized decision is written back.
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]{1,80}$')][string]$Agent,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z_]{1,80}$')][string]$Event
)
$ProgressPreference = 'SilentlyContinue'
$env:ELECTRON_RUN_AS_NODE = '1'
$arguments = '"' + $Script + '" --agent "' + $Agent + '" --event "' + $Event + '"'
$process = Start-Process -FilePath $Executable -ArgumentList $arguments -NoNewWindow -Wait -PassThru
exit $process.ExitCode
