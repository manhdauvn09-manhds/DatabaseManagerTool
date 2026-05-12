<#
.SYNOPSIS
    Deploy DatabaseManager: commit local changes, push to git, SSH to server, pull, rebuild Docker, verify.

.DESCRIPTION
    Workflow:
      1. (local) git add -A + commit + push   [skip with -SkipCommit / -SkipPush]
      2. (server) ssh <user>@<server> "cd <path> && git pull && docker compose up -d --build"
      3. (local) Health check the public URL   [skip with -SkipVerify]

    Config can be passed as parameters OR read from deploy.config.json at the repo root.

.PARAMETER Server
    Server hostname or IP. Required (or set in deploy.config.json).

.PARAMETER User
    SSH user. Required.

.PARAMETER Path
    Absolute path on server where the repo lives (e.g. /opt/DatabaseManager).

.PARAMETER Branch
    Git branch to push and pull. Default: main.

.PARAMETER Message
    Commit message. If omitted and there are local changes, you will be prompted.

.PARAMETER HealthUrl
    URL to GET after deploy (e.g. https://db.example.com/api/crypto/public-key).
    A 200 response = healthy. If omitted, falls back to http://<Server>:<APP_PORT|3000>/api/crypto/public-key.

.PARAMETER SshKey
    Path to private key file (passed via -i to ssh). Optional.

.PARAMETER SkipCommit
    Don't run git add/commit. Useful if you already committed manually.

.PARAMETER SkipPush
    Don't push. Useful for dry runs.

.PARAMETER SkipDeploy
    Skip the SSH deploy step. Useful when you only want to push.

.PARAMETER SkipVerify
    Skip the health check.

.EXAMPLE
    .\deploy.ps1 -Server 1.2.3.4 -User deploy -Path /opt/DatabaseManager -Message "fix: signin Suspense"

.EXAMPLE
    .\deploy.ps1 -Message "feat: add audit log" -HealthUrl https://db.example.com/api/crypto/public-key
    # (reads Server/User/Path from deploy.config.json)
#>

[CmdletBinding()]
param(
    [string]$Server,
    [string]$User,
    [string]$Path,
    [string]$Branch = "main",
    [string]$Message,
    [string]$HealthUrl,
    [string]$SshKey,
    [switch]$SkipCommit,
    [switch]$SkipPush,
    [switch]$SkipDeploy,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

# Force UTF-8 so emoji icons render correctly in modern Windows Terminal / PowerShell 7+.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Output convention (per /deploy-to-test): ⏳ in-progress / ✅ success / ⚠️ warning / ❗ error
function Write-Step($msg) { Write-Host ""; Write-Host "$([char]0x23F3) $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "$([char]0x2705) $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "$([char]0x26A0) $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "$([char]0x2757) $msg" -ForegroundColor Red }

# --- 0. Locate repo root + load config -----------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$cfgPath = Join-Path $scriptDir "deploy.config.json"
if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if (-not $Server     -and $cfg.Server)     { $Server     = $cfg.Server }
    if (-not $User       -and $cfg.User)       { $User       = $cfg.User }
    if (-not $Path       -and $cfg.Path)       { $Path       = $cfg.Path }
    if (-not $HealthUrl  -and $cfg.HealthUrl)  { $HealthUrl  = $cfg.HealthUrl }
    if (-not $SshKey     -and $cfg.SshKey)     { $SshKey     = $cfg.SshKey }
    if ($PSBoundParameters.ContainsKey('Branch') -eq $false -and $cfg.Branch) { $Branch = $cfg.Branch }
}

if (-not $SkipDeploy) {
    if (-not $Server) { throw "Missing -Server (or set in deploy.config.json)" }
    if (-not $User)   { throw "Missing -User"   }
    if (-not $Path)   { throw "Missing -Path"   }
}

# --- 1. Sanity: git available + inside a repo ----------------------------
Write-Step "Checking git repo"
$null = & git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Not in a git repository. Run 'git init' + add a remote first, then re-run this script."
}
Write-Ok "git repo OK"

# --- 2. Commit -----------------------------------------------------------
if (-not $SkipCommit) {
    Write-Step "Staging + committing local changes"
    $changes = & git status --porcelain
    if ($changes) {
        if (-not $Message) {
            $Message = Read-Host "Commit message"
            if ([string]::IsNullOrWhiteSpace($Message)) { throw "Empty commit message" }
        }
        & git add -A
        if ($LASTEXITCODE -ne 0) { throw "git add failed" }
        & git commit -m $Message
        if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
        Write-Ok "Committed"
    } else {
        Write-Warn2 "No local changes to commit."
    }
} else {
    Write-Warn2 "SkipCommit: skipping commit step"
}

# --- 3. Push -------------------------------------------------------------
if (-not $SkipPush) {
    Write-Step "Pushing to origin/$Branch"
    & git push origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    Write-Ok "Pushed"
} else {
    Write-Warn2 "SkipPush: skipping push step"
}

# --- 4. Deploy on server -------------------------------------------------
if (-not $SkipDeploy) {
    Write-Step "Deploying on ${User}@${Server}:${Path}"

    $sshArgs = @()
    if ($SshKey) { $sshArgs += @("-i", $SshKey) }
    $sshArgs += @("-o", "StrictHostKeyChecking=accept-new")
    $sshArgs += "${User}@${Server}"

    $remoteCmd = @"
set -e
cd '$Path'
echo '--- git pull ---'
git fetch --all --prune
git checkout '$Branch'
git reset --hard 'origin/$Branch'
echo '--- docker compose build + up ---'
docker compose up -d --build
echo '--- containers ---'
docker compose ps
"@

    & ssh @sshArgs $remoteCmd
    if ($LASTEXITCODE -ne 0) { throw "Remote deploy failed (ssh exit $LASTEXITCODE)" }
    Write-Ok "Server build + restart finished"
} else {
    Write-Warn2 "SkipDeploy: skipping server deploy step"
}

# --- 5. Health check -----------------------------------------------------
if (-not $SkipVerify) {
    if (-not $HealthUrl) {
        $port = $env:APP_PORT
        if (-not $port) { $port = 3000 }
        $HealthUrl = "http://${Server}:${port}/api/health"
        Write-Warn2 "No -HealthUrl provided; using $HealthUrl"
    }
    Write-Step "Health check: $HealthUrl"
    Start-Sleep -Seconds 8

    $attempts = 6
    $delay = 5
    $ok = $false
    for ($i=1; $i -le $attempts; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 15
            if ($resp.StatusCode -eq 200) {
                $body = $resp.Content
                if ($body -match '"ok":\s*true') {
                    Write-Ok "200 OK + {ok:true}"
                    $ok = $true
                    break
                } else {
                    Write-Warn2 "200 but unexpected body (try $i/$attempts)"
                }
            } else {
                Write-Warn2 "Status $($resp.StatusCode) (try $i/$attempts)"
            }
        } catch {
            Write-Warn2 "Request failed (try $i/$attempts): $($_.Exception.Message)"
        }
        if ($i -lt $attempts) { Start-Sleep -Seconds $delay }
    }

    if (-not $ok) {
        Write-Err "Health check FAILED after $attempts attempts."
        Write-Host "Debug on server: ssh ${User}@${Server} 'cd $Path && docker compose logs --tail=200 app'" -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Warn2 "SkipVerify: skipping health check"
}

Write-Host ""
Write-Host "$([char]0x2705) Deploy complete." -ForegroundColor Green
