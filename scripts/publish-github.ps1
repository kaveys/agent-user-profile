# 一键发布到 GitHub：登录（若未登录）→ 建仓库 → 推送
# 用法：pwsh -File scripts/publish-github.ps1            （仓库名默认 agent-user-profile）
#       pwsh -File scripts/publish-github.ps1 -Name my-repo -Private
param(
  [string]$Name = 'agent-user-profile',
  [switch]$Private,
  [string]$Owner = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  # 1) 登录状态
  gh auth status 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host '未登录 GitHub，开始设备码登录……' -ForegroundColor Yellow
    gh auth login --web --git-protocol https --hostname github.com
  }
  $login = (gh api user --jq .login).Trim()
  Write-Host "已登录：$login" -ForegroundColor Green

  # 2) 填 OWNER 占位
  $pkgPath = Join-Path $root 'package.json'
  $pkg = Get-Content -Raw $pkgPath
  if ($pkg -match 'github\.com/OWNER/') {
    $ownerPath = if ($Owner) { $Owner } else { $login }
    $pkg = $pkg -replace 'github\.com/OWNER/', "github.com/$ownerPath/"
    $pkg = $pkg -replace '"name": "dsh-user-profile"', '"name": "dsh-user-profile"'
    [IO.File]::WriteAllText($pkgPath, $pkg, (New-Object System.Text.UTF8Encoding($false)))
    # README 里的 OWNER 也一并换掉
    foreach ($f in @('README.md', 'README.en.md')) {
      $p = Join-Path $root $f
      if (Test-Path $p) {
        $t = Get-Content -Raw $p
        [IO.File]::WriteAllText($p, ($t -replace 'github\.com/OWNER/', "github.com/$ownerPath/"), (New-Object System.Text.UTF8Encoding($false)))
      }
    }
    git add -A
    git -c user.name=agent-user-profile -c user.email=dev@example.com commit -q -m "chore: point repository metadata at the real owner"
    Write-Host "已把 OWNER 替换为 $ownerPath 并提交" -ForegroundColor Green
  }

  # 3) 建仓库（已存在则直接用）
  $exists = gh repo view "$login/$Name" --json name --jq .name 2>$null
  if (-not $exists) {
    $vis = if ($Private) { '--private' } else { '--public' }
    gh repo create $Name $vis --source . --remote origin --description "Agent user-profile layer: distill durable preferences into a weighted portrait and overlay them on every task (DSH-first)."
    Write-Host "已创建仓库 $login/$Name" -ForegroundColor Green
  } else {
    Write-Host "仓库 $login/$Name 已存在" -ForegroundColor Yellow
    git remote get-url origin 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { git remote add origin "https://github.com/$login/$Name.git" }
  }

  # 4) 推送（github.com:443 可能不稳，多次重试；失败再试 SSH-over-443）
  $token = (gh auth token).Trim()
  $ok = $false
  for ($i = 1; $i -le 3; $i++) {
    git push -u origin main 2>&1 | Out-Host
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Write-Host "第 $i 次推送失败，5 秒后重试……" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
  }
  if (-not $ok) {
    Write-Host 'HTTPS 推送失败，改用 SSH（443 端口，需要本机已注册 SSH key）……' -ForegroundColor Yellow
    $sshUrl = "ssh://git@ssh.github.com:443/$login/$Name.git"
    git remote set-url origin $sshUrl
    git push -u origin main
  }
  Write-Host "完成：https://github.com/$login/$Name" -ForegroundColor Green
} finally {
  Pop-Location
}
