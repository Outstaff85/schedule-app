' Runs .claude/hooks/session-start.sh through Git Bash with no console window.
' Started by the "schedule-app git sync" scheduled task (scripts/install-local-sync.ps1).
' Args: <path to Git's bash.exe> <path to session-start.sh> <path to log file>
Set a = WScript.Arguments
CreateObject("WScript.Shell").Run """" & a(0) & """ -c ""bash '" & a(1) & "' > '" & a(2) & "' 2>&1""", 0, False
