$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$syncScript = Join-Path $PSScriptRoot 'sync.ps1'
$taskName = 'team-brain 동기화'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$syncScript`""
$trigger = New-ScheduledTaskTrigger -Daily -At '9:00 AM'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Description "매일 오전 9시에 $repoRoot 회의록을 fast-forward 동기화합니다."

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Write-Output "등록했습니다: $taskName (매일 오전 9시)"
