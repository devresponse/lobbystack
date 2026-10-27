<#
.SYNOPSIS
  Deletes the whole knowledge base of the Strata LMS 869 business, then uploads every PDF
  in C:\Clients\LMS869 to be read again.

.DESCRIPTION
  Uses the lobbystack CLI from source (pnpm lobbystack, in the lobbystack repo) with the
  saved CLI profile. It deletes every knowledge entry (texts and FAQs) and every knowledge
  source (uploaded files, websites and their pages), then uploads each PDF with a title and
  tags taken from its file name and waits until the PDF is read. Rules, the receptionist and
  the public profile are left alone.

  Deleting can't be undone. Run with -DryRun first: it only lists what would be deleted and
  uploaded.

  Limits on the server: a file can be at most 10 MB, so bigger PDFs are skipped and listed at
  the end. Scanned PDFs (no text layer) are read with OCR, up to their first 10 pages.

.EXAMPLE
  .\reload-kb-from-pdfs.ps1 -DryRun
  .\reload-kb-from-pdfs.ps1
#>
param(
  [string]$Business = "04becd97-e05d-4458-a9d9-8fa248be56fd",
  [string]$SourceFolder = "C:\Clients\LMS869",
  [string]$RepoRoot = "C:\my\repos\lobbystack",
  [string]$Profile = "",
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$MaxBytes = 10MB
$StateFile = Join-Path $PSScriptRoot "lms869-kb.state.json"

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

# Title and tags from names like 2026-02-26_LMS869_Bylaws_Consolidated.pdf.
function Get-UploadInfo([System.IO.FileInfo]$File) {
  $parts = $File.BaseName -split "_"
  $date = $parts[0]
  $kind = if ($parts.Count -ge 3) { $parts[2] } else { "Document" }
  $detail = if ($parts.Count -ge 4) { ($parts[3..($parts.Count - 1)] -join " ") } else { "" }
  $title = ("LMS 869 " + ($kind -replace "-", " ") + " " + ($detail -replace "-", " ") + " (" + $date + ")") -replace "\s+", " "
  $year = $date.Substring(0, 4)
  $tags = @("lms869", "source-pdf", $kind.ToLower(), "y$year") -join ","
  return @{ Title = $title.Trim(); Tags = $tags }
}

Write-Host "Checking the API key and business..."
$who = Invoke-Lobbystack -Arguments @("whoami")
Write-Host $who.Output
Write-Host ""

$entries = @((Invoke-Lobbystack -Arguments @("knowledge", "list", "--all") -Json).data)
$sources = @((Invoke-Lobbystack -Arguments @("knowledge", "sources", "--all") -Json).data)
$pdfs = @(Get-ChildItem -Path $SourceFolder -Filter *.pdf -File | Sort-Object Name)
$tooBig = @($pdfs | Where-Object { $_.Length -gt $MaxBytes })
$toUpload = @($pdfs | Where-Object { $_.Length -le $MaxBytes })

Write-Host "To delete: $($entries.Count) text/FAQ entries and $($sources.Count) sources (files, websites, pages)."
foreach ($s in $sources) { Write-Host ("  - [{0}] {1}" -f $s.type, $s.title) }
foreach ($e in $entries) { Write-Host ("  - [{0}] {1}" -f $e.type, $e.title) }
Write-Host ""
Write-Host "To upload: $($toUpload.Count) PDFs from $SourceFolder."
foreach ($f in $toUpload) { $i = Get-UploadInfo $f; Write-Host ("  + {0}  ->  {1}  [{2}]" -f $f.Name, $i.Title, $i.Tags) }
foreach ($f in $tooBig) { Write-Host ("  ! skipped, over 10 MB ({0:N1} MB): {1}" -f ($f.Length / 1MB), $f.Name) -ForegroundColor Yellow }
Write-Host ""

if ($DryRun) { Write-Host "Dry run: nothing was changed."; exit 0 }

if (-not $Yes) {
  $answer = Read-Host "This deletes the whole knowledge base above and can't be undone. Type DELETE to continue"
  if ($answer -ne "DELETE") { Write-Host "Stopped. Nothing was changed."; exit 1 }
}

# 1. Delete everything. A page can disappear with its website, so a 404 is fine.
$deleteFailures = @()
foreach ($s in $sources) {
  $r = Invoke-Lobbystack -Arguments @("knowledge", "source-remove", $s.id) -AllowFailure
  if ($r.ExitCode -eq 0) { Write-Host "Deleted source: $($s.title)" }
  elseif ($r.Output -match "404|not found") { Write-Host "Already gone: $($s.title)" }
  else { $deleteFailures += "$($s.title): $($r.Output)"; Write-Host "FAILED to delete $($s.title)" -ForegroundColor Red }
}
foreach ($e in $entries) {
  $r = Invoke-Lobbystack -Arguments @("knowledge", "remove", $e.id) -AllowFailure
  if ($r.ExitCode -eq 0) { Write-Host "Deleted entry: $($e.title)" }
  else { $deleteFailures += "$($e.title): $($r.Output)"; Write-Host "FAILED to delete $($e.title)" -ForegroundColor Red }
}
if ($deleteFailures.Count) { throw "Stopped before uploading, because $($deleteFailures.Count) deletes failed:`n$($deleteFailures -join "`n")" }

# The onboard state file lists the .txt uploads that were just deleted; move it aside so a
# later lobbystack onboard run of lms869-kb.yaml uploads them again instead of skipping them.
if (Test-Path $StateFile) {
  $backup = "$StateFile.$(Get-Date -Format yyyyMMdd-HHmmss).bak"
  Move-Item $StateFile $backup
  Write-Host "Moved the onboard state file aside: $backup"
}

# 2. Upload the PDFs one at a time and wait for each to be read.
$results = @()
foreach ($f in $toUpload) {
  $i = Get-UploadInfo $f
  Write-Host "Uploading $($f.Name)..."
  $r = Invoke-Lobbystack -Arguments @("knowledge", "upload", $f.FullName, "--title", $i.Title, "--tags", $i.Tags, "--wait") -AllowFailure
  $status = if ($r.ExitCode -eq 0) { "indexed" } else { "FAILED" }
  if ($status -eq "FAILED") { Write-Host $r.Output -ForegroundColor Red }
  $results += [pscustomobject]@{ File = $f.Name; Status = $status }
}

Write-Host ""
$results | Format-Table -AutoSize
$failed = @($results | Where-Object Status -eq "FAILED")
Write-Host "Uploaded and read: $($results.Count - $failed.Count). Failed: $($failed.Count). Skipped over 10 MB: $($tooBig.Count)."
foreach ($f in $tooBig) { Write-Host "  Skipped: $($f.Name)" -ForegroundColor Yellow }
if ($failed.Count) { exit 1 }
