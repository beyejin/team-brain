$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $env:LOCALAPPDATA 'team-brain'
$logPath = Join-Path $logRoot 'sync.log'

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
Start-Transcript -Path $logPath -Append | Out-Null

try {
    $changes = git -C $repoRoot status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw 'Git status를 확인하지 못했습니다.'
    }
    if ($changes) {
        throw '로컬 변경사항이 있어 자동 동기화를 멈춥니다. 변경사항을 먼저 검토하고 커밋하거나 보관해 주세요.'
    }

    git -C $repoRoot pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        throw '원격 변경사항을 fast-forward로 적용하지 못했습니다.'
    }
}
catch {
    Write-Error $_
    exit 1
}
finally {
    Stop-Transcript | Out-Null
}
