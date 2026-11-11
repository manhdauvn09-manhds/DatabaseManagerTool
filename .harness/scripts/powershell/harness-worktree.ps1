#!/usr/bin/env pwsh
<#
.SYNOPSIS
  C16 worktree budget -- status / finish / git hook, and the SessionStart + Stop hooks.
.DESCRIPTION
  Thin wrapper over .harness/scripts/lib/harness_worktree.py so PowerShell and bash
  decide identically (C7). Policy: casan-policies.yaml -> worktrees (C2).

    status            list the worktrees besides main and their state (-Json for JSON)
    finish            merge this worktree's branch into main, push, remove the
                      worktree, delete the branch with -d. Never --force. Run it
                      from inside the worktree, or pass -Path <worktree>.
    install-git-hook  write a post-checkout hook that warns Codex / a person when
                      `git worktree add` goes over budget (git cannot undo the add)
    start | stop      hook modes (read the hook JSON on stdin; always exit 0)

  Local defense-in-depth (C10): Claude Code's PreToolUse guard denies creating a
  worktree over budget; for tools without hooks this only detects and warns.
.EXAMPLE
  powershell -NoProfile -File E:\repo\.harness\scripts\powershell\harness-worktree.ps1 finish
.EXAMPLE
  powershell -NoProfile -File E:\repo\.harness\scripts\powershell\harness-worktree.ps1 finish -Path E:\repo\.claude\worktrees\x
#>
param(
    [Parameter(Position = 0)][string]$Mode = "status",
    [string]$Path = "",
    [switch]$NoPush,
    [switch]$Json
)

$Root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$Lib = Join-Path $PSScriptRoot "..\lib\harness_worktree.py"
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

if (@("start", "stop") -contains $Mode) {
    # Hook modes: fail-open, never trap a session (C14).
    try {
        if (-not $py -or -not (Test-Path $Lib)) { exit 0 }
        $raw = ""
        if ($Mode -eq "stop") {
            # Raw UTF-8 bytes: the console codepage would mangle non-ASCII paths.
            $ms = New-Object System.IO.MemoryStream
            [Console]::OpenStandardInput().CopyTo($ms)
            $raw = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
        }
        $raw | & $py.Source $Lib $Mode $Root
    } catch { }
    exit 0
}

if (-not $py) { Write-Host "python khong co tren PATH"; exit 1 }
if (-not (Test-Path $Lib)) { Write-Host "khong thay $Lib"; exit 1 }

$cliArgs = @($Lib, $Mode, $Root)
if ($Path) { $cliArgs += @("--path", $Path) }
if ($NoPush) { $cliArgs += "--no-push" }
if ($Json) { $cliArgs += "--json" }
& $py.Source @cliArgs
exit $LASTEXITCODE
