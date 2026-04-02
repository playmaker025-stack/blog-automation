# blog-automation dotfile 설치 스크립트
# 프로젝트를 C: 등 dotfile 지원 드라이브로 이동 후 실행할 것
#
# 사용법: PowerShell에서 실행
#   cd <프로젝트 루트>
#   .\_dotfiles\setup.ps1

$ProjectRoot = $PSScriptRoot | Split-Path -Parent
$DotfilesDir = $PSScriptRoot

Write-Host "Project root: $ProjectRoot"

# .mcp.json
Copy-Item -Path "$DotfilesDir\mcp.json" -Destination "$ProjectRoot\.mcp.json" -Force
Write-Host "[OK] .mcp.json 생성"

# .env.local.example
Copy-Item -Path "$DotfilesDir\env.local.example" -Destination "$ProjectRoot\.env.local.example" -Force
Write-Host "[OK] .env.local.example 생성"

# .claude/agents/
$AgentsDir = "$ProjectRoot\.claude\agents"
New-Item -ItemType Directory -Path $AgentsDir -Force | Out-Null
Get-ChildItem -Path "$DotfilesDir\claude\agents\*.md" | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination "$AgentsDir\$($_.Name)" -Force
    Write-Host "[OK] .claude/agents/$($_.Name) 생성"
}

# .claude/commands/
$CommandsDir = "$ProjectRoot\.claude\commands"
New-Item -ItemType Directory -Path $CommandsDir -Force | Out-Null
Get-ChildItem -Path "$DotfilesDir\claude\commands\*.md" | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination "$CommandsDir\$($_.Name)" -Force
    Write-Host "[OK] .claude/commands/$($_.Name) 생성"
}

Write-Host ""
Write-Host "=== 설치 완료 ==="
Write-Host "다음 단계:"
Write-Host "  1. .env.local.example 을 .env.local 로 복사 후 값 입력"
Write-Host "  2. npm install 실행"
Write-Host "  3. npm run dev 실행"
