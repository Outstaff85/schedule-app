# Keeps this PC's clone of the repo in sync with GitHub: registers a Windows scheduled
# task that runs .claude/hooks/session-start.sh (the same fast-forward-only sync Claude Code
# runs at session start) at logon and every 15 minutes, in a hidden window.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-local-sync.ps1             # install / update
#   powershell -ExecutionPolicy Bypass -File scripts\install-local-sync.ps1 -Uninstall  # remove
#
# Last run's result: .git\local-sync.log
param([switch]$Uninstall, [int]$EveryMinutes = 15)

$TaskName = 'schedule-app git sync'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'."
  exit 0
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$hook = Join-Path $repo '.claude\hooks\session-start.sh'
$vbs  = Join-Path $repo 'scripts\local-sync-hidden.vbs'
$log  = Join-Path $repo '.git\local-sync.log'

# Git for Windows' own bash (not WSL's System32\bash.exe): <Git>\cmd\git.exe -> <Git>\bin\bash.exe
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { Write-Error 'git not found in PATH - install Git for Windows first.'; exit 1 }
$bash = Join-Path (Split-Path (Split-Path $git)) 'bin\bash.exe'
if (-not (Test-Path $bash)) { Write-Error "Git Bash not found at $bash"; exit 1 }

# bash wants forward slashes
$toBash = { param($p) $p -replace '\\', '/' }
$arg = '"{0}" "{1}" "{2}" "{3}"' -f $vbs, $bash, (& $toBash $hook), (& $toBash $log)

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $arg -WorkingDirectory $repo
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes))
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
  -Description "Fast-forwards $repo to GitHub (origin/main or its own branch). Never merges or discards changes." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed '$TaskName' for $repo (at logon + every $EveryMinutes min)."
Write-Host "Last result: $log"
