<#
.SYNOPSIS
  Deletes the whole AI knowledge base of one LobbyStack business.

.DESCRIPTION
  Uses the lobbystack CLI from source (pnpm lobbystack, in the lobbystack repo) with the
  saved CLI profile. Deletes every knowledge source (uploaded files, websites and the pages
  their crawls read) and every knowledge entry (texts and FAQs). Rules, the receptionist,
  services and the public profile are left alone.

  Deleting can't be undone. Run with -DryRun first: it only lists what would be deleted.

.EXAMPLE
  .\delete-kb.ps1 -DryRun
  .\delete-kb.ps1
  .\delete-kb.ps1 -Business <business id> -Profile plumbing
#>
param(
  [string]$Business = "04becd97-e05d-4458-a9d9-8fa248be56fd",
  [string]$RepoRoot = "C:\my\repos\lobbystack",
  [string]$Profile = "",
  [string]$StateFile = (Join-Path $PSScriptRoot "lms869-kb.state.json"),
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

function Invoke-Lobbystack {
  param([string[]]$Arguments, [switch]$Json, [switch]$AllowFailure)
  $all = @($Arguments) + @("--business", $Business)
  if ($Profile) { $all += @("--profile", $Profile) }
  if ($Json) { $all += "--json" }
  Push-Location $RepoRoot
  try {
    $output = & pnpm -s lobbystack @all 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0 -and -not $AllowFailure) { throw "lobbystack $($Arguments -join ' ') failed ($code): $output" }
  if ($Json -and $code -eq 0) { return $output | ConvertFrom-Json }
  return [pscustomobject]@{ ExitCode = $code; Output = $output.Trim() }
}

Write-Host "Checking the API key and business..."
Write-Host (Invoke-Lobbystack -Arguments @("whoami")).Output
Write-Host ""

$sources = @((Invoke-Lobbystack -Arguments @("knowledge", "sources", "--all") -Json).data)
$entries = @((Invoke-Lobbystack -Arguments @("knowledge", "list", "--all") -Json).data)

Write-Host "To delete: $($sources.Count) sources (files, websites, pages) and $($entries.Count) text/FAQ entries."
foreach ($s in $sources) { Write-Host ("  - [{0}] {1}" -f $s.type, $s.title) }
foreach ($e in $entries) { Write-Host ("  - [{0}] {1}" -f $e.type, $e.title) }
Write-Host ""

if ($sources.Count + $entries.Count -eq 0) { Write-Host "The knowledge base is already empty."; exit 0 }
if ($DryRun) { Write-Host "Dry run: nothing was changed."; exit 0 }

if (-not $Yes) {
  $answer = Read-Host "This deletes the whole knowledge base above and can't be undone. Type DELETE to continue"
  if ($answer -ne "DELETE") { Write-Host "Stopped. Nothing was changed."; exit 1 }
}

# Websites first, so their crawls stop; then pages and files. A page can disappear with its
# website, so a 404 counts as done.
$ordered = @($sources | Where-Object type -eq "website") + @($sources | Where-Object type -ne "website")
$failures = @()
foreach ($s in $ordered) {
  $r = Invoke-Lobbystack -Arguments @("knowledge", "source-remove", $s.id) -AllowFailure
  if ($r.ExitCode -eq 0) { Write-Host "Deleted source: $($s.title)" }
  elseif ($r.Output -match "404|not found") { Write-Host "Already gone: $($s.title)" }
  else { $failures += "$($s.title): $($r.Output)"; Write-Host "FAILED: $($s.title)" -ForegroundColor Red }
}
foreach ($e in $entries) {
  $r = Invoke-Lobbystack -Arguments @("knowledge", "remove", $e.id) -AllowFailure
  if ($r.ExitCode -eq 0) { Write-Host "Deleted entry: $($e.title)" }
  else { $failures += "$($e.title): $($r.Output)"; Write-Host "FAILED: $($e.title)" -ForegroundColor Red }
}

# An onboard state file would still list the deleted uploads, so the next lobbystack onboard
# run would skip them. Move it aside so that run uploads them again.
if ($StateFile -and (Test-Path $StateFile)) {
  $backup = "$StateFile.$(Get-Date -Format yyyyMMdd-HHmmss).bak"
  Move-Item $StateFile $backup
  Write-Host "Moved the onboard state file aside: $backup"
}

$left = @((Invoke-Lobbystack -Arguments @("knowledge", "sources", "--all") -Json).data).Count + @((Invoke-Lobbystack -Arguments @("knowledge", "list", "--all") -Json).data).Count
Write-Host ""
Write-Host "Deleted. Failures: $($failures.Count). Items left in the knowledge base: $left."
if ($failures.Count) { $failures | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }; exit 1 }
