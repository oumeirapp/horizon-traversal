Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Fail {
  param([Parameter(Mandatory = $true)][string]$Message)
  throw $Message
}

function Require-File {
  param([Parameter(Mandatory = $true)][string]$Path, [string]$Label = "required file")
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Fail "$Label is missing: $Path"
  }
}

function Write-OversizedPng {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $SourceImage = [System.Drawing.Image]::FromFile($Source)
  try {
    $Bitmap = New-Object System.Drawing.Bitmap -ArgumentList 2400, 1500
    try {
      $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
      try {
        $Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $Graphics.DrawImage($SourceImage, 0, 0, 2400, 1500)
      } finally {
        $Graphics.Dispose()
      }
      $Bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $Bitmap.Dispose()
    }
  } finally {
    $SourceImage.Dispose()
  }
  Require-File -Path $Destination -Label "oversized PNG fixture"
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Program,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$Description = "command"
  )
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$Description exited with status $LASTEXITCODE"
  }
}

function Assert-Unsigned {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $Signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
    Fail "$Label must be unsigned for this distribution; signature status is $($Signature.Status)"
  }
}

function Invoke-NsisProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description,
    [int]$TimeoutSeconds = 300
  )
  $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $StartInfo.FileName = $Executable
  $StartInfo.Arguments = $Arguments
  $StartInfo.UseShellExecute = $false
  $StartInfo.CreateNoWindow = $true
  $Process = New-Object System.Diagnostics.Process
  $Process.StartInfo = $StartInfo
  if (-not $Process.Start()) {
    Fail "could not start $Description"
  }
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $Process.Kill() } catch { Write-Warning $_.Exception.Message }
    $Process.WaitForExit()
    Fail "$Description did not finish within ${TimeoutSeconds}s"
  }
  if ($Process.ExitCode -ne 0) {
    Fail "$Description exited with status $($Process.ExitCode)"
  }
}

function Get-HorizonUninstallEntries {
  param([Parameter(Mandatory = $true)][ValidateSet("CurrentUser", "LocalMachine")][string]$Hive)

  if ($Hive -eq "CurrentUser") {
    $Roots = @(
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
      "HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    )
  } else {
    $Roots = @(
      "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
      "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    )
  }

  $Entries = @()
  foreach ($Root in $Roots) {
    if (Test-Path -LiteralPath $Root) {
      $Entries += @(
        Get-ChildItem -LiteralPath $Root -ErrorAction Stop |
          ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop } |
          Where-Object {
            $null -ne $_.PSObject.Properties["DisplayName"] -and
              $_.DisplayName -eq "Horizon Traversal"
          }
      )
    }
  }
  return @($Entries)
}

function Wait-ForPathRemoval {
  param([Parameter(Mandatory = $true)][string]$Path, [int]$TimeoutSeconds = 30)
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ((Test-Path -LiteralPath $Path) -and [DateTime]::UtcNow -lt $Deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $Path) {
    Fail "uninstaller did not remove the install directory within ${TimeoutSeconds}s: $Path"
  }
}

function Wait-ForUninstallRegistrationRemoval {
  param([int]$TimeoutSeconds = 30)
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $Deadline) {
    $CurrentUserCount = @(Get-HorizonUninstallEntries -Hive "CurrentUser").Count
    $LocalMachineCount = @(Get-HorizonUninstallEntries -Hive "LocalMachine").Count
    if ($CurrentUserCount -eq 0 -and $LocalMachineCount -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  Fail "uninstaller did not remove its registry entries within ${TimeoutSeconds}s"
}

function Invoke-PackagedApplication {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$RequestJson,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $StartInfo.FileName = $Executable
  $StartInfo.UseShellExecute = $false
  $StartInfo.CreateNoWindow = $true
  $StartInfo.EnvironmentVariables["HORIZON_TRAVERSAL_PACKAGED_SMOKE_REQUEST"] = $RequestJson
  $Process = New-Object System.Diagnostics.Process
  $Process.StartInfo = $StartInfo
  if (-not $Process.Start()) {
    Fail "could not start the installed application"
  }
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $Process.Kill() } catch { Write-Warning $_.Exception.Message }
    $Process.WaitForExit()
    Fail "packaged app did not finish within ${TimeoutSeconds}s; was it built with packaged-smoke?"
  }
  if ($Process.ExitCode -ne 0) {
    Fail "packaged application exited with status $($Process.ExitCode)"
  }
}

function Read-ProbeStream {
  param(
    [Parameter(Mandatory = $true)][string]$Ffprobe,
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$Selector,
    [Parameter(Mandatory = $true)][string]$Entries
  )
  $JsonLines = & $Ffprobe -v error -select_streams $Selector -show_entries $Entries -of json $File
  if ($LASTEXITCODE -ne 0) {
    Fail "ffprobe failed for $File"
  }
  $Json = $JsonLines -join [Environment]::NewLine
  $Probe = $Json | ConvertFrom-Json
  if (@($Probe.streams).Count -ne 1) {
    Fail "expected exactly one $Selector stream in $File"
  }
  return @($Probe.streams)[0]
}

function Assert-ImageBounds {
  param([Parameter(Mandatory = $true)][string]$File)

  $Image = [System.Drawing.Image]::FromFile($File)
  try {
    $Width = $Image.Width
    $Height = $Image.Height
  } finally {
    $Image.Dispose()
  }
  if ($Width -le 0 -or $Height -le 0) {
    Fail "image has invalid dimensions after processing: $File (${Width}x${Height})"
  }
  if ($Width -gt 1920 -or $Height -gt 1080) {
    Fail "image exceeds 1920x1080 after processing: $File (${Width}x${Height})"
  }
}

function Write-JsonFile {
  param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$Path)
  $Parent = Split-Path -Parent $Path
  if ([string]::IsNullOrWhiteSpace($Parent)) {
    Fail "JSON report path must include a parent directory: $Path"
  }
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  $Value | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Normalize-WindowsPathForComparison {
  param([Parameter(Mandatory = $true)][string]$Path)
  $Normalized = $Path
  if ($Normalized.StartsWith("\\?\UNC\", [StringComparison]::OrdinalIgnoreCase)) {
    $Normalized = "\\" + $Normalized.Substring(8)
  } elseif ($Normalized.StartsWith("\\?\", [StringComparison]::OrdinalIgnoreCase)) {
    $Normalized = $Normalized.Substring(4)
  }
  return [IO.Path]::GetFullPath($Normalized).TrimEnd('\')
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  Fail "packaged Windows smoke requires Windows"
}
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
  Fail "packaged Windows smoke must run natively in a 64-bit process on Windows x64"
}
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) {
  Fail "packaged Windows smoke requires Windows PowerShell 5.1"
}
try {
  Add-Type -AssemblyName System.Drawing
} catch {
  Fail "packaged Windows smoke requires System.Drawing: $($_.Exception.Message)"
}

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repository = [IO.Path]::GetFullPath((Join-Path $ScriptDirectory "..\.."))
$Target = "x86_64-pc-windows-msvc"
$NativeManifest = Join-Path $Repository "src-tauri\native-assets.json"
$SourceFfmpeg = Join-Path $Repository "src-tauri\binaries\ffmpeg-$Target.exe"
$SourceFfprobe = Join-Path $Repository "src-tauri\binaries\ffprobe-$Target.exe"
$SourcePdfium = Join-Path $Repository "src-tauri\resources\native\pdfium.dll"
$PdfFixture = Join-Path $Repository "src-tauri\tests\fixtures\one-page.pdf"
$ImageFixture = Join-Path $Repository "src-tauri\icons\128x128@2x.png"
$Inspector = Join-Path $Repository "scripts\inspect-bundle-windows-x64.mjs"

foreach ($Required in @($NativeManifest, $SourceFfmpeg, $SourceFfprobe, $SourcePdfium, $PdfFixture, $ImageFixture, $Inspector)) {
  Require-File -Path $Required
}

$Node = Get-Command node.exe -ErrorAction Stop
$Npm = Get-Command npm.cmd -ErrorAction Stop
$NodeVersion = (& $Node.Source -p "process.versions.node").Trim()
if ($LASTEXITCODE -ne 0 -or $NodeVersion -ne "24.14.0") {
  Fail "packaged Windows smoke requires Node 24.14.0; received $NodeVersion"
}
$NpmVersion = (& $Npm.Source "--version").Trim()
if ($LASTEXITCODE -ne 0 -or $NpmVersion -ne "11.9.0") {
  Fail "packaged Windows smoke requires npm 11.9.0; received $NpmVersion"
}

$ExistingCurrentUser = @(Get-HorizonUninstallEntries -Hive "CurrentUser")
$ExistingLocalMachine = @(Get-HorizonUninstallEntries -Hive "LocalMachine")
if ($ExistingCurrentUser.Count -ne 0 -or $ExistingLocalMachine.Count -ne 0) {
  Fail "refusing to alter an existing Horizon Traversal installation during package smoke"
}

$WorkspaceName = "horizon-traversal-package-smoke-$([Guid]::NewGuid().ToString('N'))"
$Workspace = Join-Path ([IO.Path]::GetTempPath()) $WorkspaceName
$Workspace = [IO.Path]::GetFullPath($Workspace)
$InstallDirectory = Join-Path $Workspace "installed"
$CargoTargetDirectory = Join-Path $Workspace "cargo-target"
$InputDirectory = Join-Path $Workspace "input"
$OutputDirectory = Join-Path $Workspace "output"
$SourceDirectory = Join-Path $InputDirectory "P1 Packaged Smoke\Deliverables"
$ResultPath = Join-Path $Workspace "pipeline-result.json"
$InspectionPath = Join-Path $Workspace "bundle-inspection.json"
$RequestPath = Join-Path $Workspace "request.json"
$Installed = $false
$SmokeSucceeded = $false
$UninstallVerified = $false

New-Item -ItemType Directory -Path $Workspace | Out-Null

try {
  Push-Location $Repository
  try {
    Invoke-Checked -Program $Npm.Source -Arguments @("run", "verify:native") -Description "native verification"
    $PreviousCargoTarget = $env:CARGO_TARGET_DIR
    try {
      $env:CARGO_TARGET_DIR = $CargoTargetDirectory
      Invoke-Checked -Program $Npm.Source -Arguments @(
        "run", "tauri", "--", "build",
        "--target", $Target,
        "--features", "packaged-smoke",
        "--bundles", "nsis",
        "--ci",
        "--no-sign"
      ) -Description "smoke-feature NSIS build"
    } finally {
      if ($null -eq $PreviousCargoTarget) {
        Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
      } else {
        $env:CARGO_TARGET_DIR = $PreviousCargoTarget
      }
    }
  } finally {
    Pop-Location
  }

  $NsisDirectory = Join-Path $CargoTargetDirectory "$Target\release\bundle\nsis"
  if (-not (Test-Path -LiteralPath $NsisDirectory -PathType Container)) {
    Fail "Tauri did not produce an NSIS output directory: $NsisDirectory"
  }
  $Installers = @(Get-ChildItem -LiteralPath $NsisDirectory -Filter "*.exe" -File)
  if ($Installers.Count -ne 1) {
    Fail "expected exactly one smoke-feature NSIS installer, found $($Installers.Count)"
  }
  $Installer = $Installers[0].FullName
  Assert-Unsigned -Path $Installer -Label "NSIS installer"

  $Installed = $true
  # NSIS requires /D to be the final command-line option. It consumes the
  # remainder of the command line, so paths containing spaces remain intact.
  Invoke-NsisProcess -Executable $Installer -Arguments "/S /D=$InstallDirectory" -Description "NSIS installer"

  $CurrentUserEntries = @(Get-HorizonUninstallEntries -Hive "CurrentUser")
  $LocalMachineEntries = @(Get-HorizonUninstallEntries -Hive "LocalMachine")
  if ($CurrentUserEntries.Count -ne 1) {
    Fail "expected one HKCU uninstall registration, found $($CurrentUserEntries.Count)"
  }
  if ($LocalMachineEntries.Count -ne 0) {
    Fail "the per-user installer unexpectedly wrote an HKLM uninstall registration"
  }
  if ($null -eq $CurrentUserEntries[0].PSObject.Properties["InstallLocation"] -or [string]::IsNullOrWhiteSpace($CurrentUserEntries[0].InstallLocation)) {
    Fail "HKCU uninstall registration has no InstallLocation"
  }
  $RegisteredLocationValue = ([string]$CurrentUserEntries[0].InstallLocation).Trim().Trim('"')
  $RegisteredLocation = [IO.Path]::GetFullPath($RegisteredLocationValue).TrimEnd('\')
  if (-not $RegisteredLocation.Equals($InstallDirectory.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    Fail "HKCU InstallLocation does not match the requested current-user path: $RegisteredLocation"
  }

  $ApplicationCandidates = @(
    Get-ChildItem -LiteralPath $InstallDirectory -Filter "*.exe" -File |
      Where-Object { $_.Name -notin @("ffmpeg.exe", "ffprobe.exe", "uninstall.exe") }
  )
  if ($ApplicationCandidates.Count -ne 1) {
    Fail "expected exactly one installed application executable, found $($ApplicationCandidates.Count)"
  }
  $Application = $ApplicationCandidates[0].FullName
  $Uninstaller = Join-Path $InstallDirectory "uninstall.exe"
  Require-File -Path $Uninstaller -Label "NSIS uninstaller"
  Assert-Unsigned -Path $Application -Label "installed application"

  Invoke-Checked -Program $Node.Source -Arguments @(
    $Inspector,
    "--install-directory", $InstallDirectory,
    "--app-executable", $Application,
    "--source-manifest", $NativeManifest,
    "--report", $InspectionPath
  ) -Description "installed bundle inspection"

  New-Item -ItemType Directory -Path $SourceDirectory | Out-Null
  Copy-Item -LiteralPath $PdfFixture -Destination (Join-Path $SourceDirectory "brief.pdf")
  Write-OversizedPng -Source $ImageFixture -Destination (Join-Path $SourceDirectory "visual.png")
  Invoke-Checked -Program $SourceFfmpeg -Arguments @(
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x0c756d:s=1080x1920:r=10",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100",
    "-t", "0.2", "-shortest",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le",
    (Join-Path $SourceDirectory "clip.mp4")
  ) -Description "video-with-audio fixture generation"

  $Request = [ordered]@{
    inputPath = $InputDirectory
    outputPath = $OutputDirectory
    ticketFilter = "P1"
    processingOptions = [ordered]@{ pdf = $true; images = $true; video = $true }
    resultPath = $ResultPath
  }
  Write-JsonFile -Value $Request -Path $RequestPath
  $RequestJson = $Request | ConvertTo-Json -Depth 10 -Compress
  $TimeoutSeconds = 180
  if (-not [string]::IsNullOrWhiteSpace($env:HORIZON_TRAVERSAL_SMOKE_TIMEOUT_SECONDS)) {
    $ParsedTimeout = 0
    if (-not [int]::TryParse($env:HORIZON_TRAVERSAL_SMOKE_TIMEOUT_SECONDS, [ref]$ParsedTimeout) -or $ParsedTimeout -le 0) {
      Fail "HORIZON_TRAVERSAL_SMOKE_TIMEOUT_SECONDS must be a positive integer"
    }
    $TimeoutSeconds = $ParsedTimeout
  }
  Invoke-PackagedApplication -Executable $Application -RequestJson $RequestJson -TimeoutSeconds $TimeoutSeconds
  Require-File -Path $ResultPath -Label "packaged pipeline result"
  $Result = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
  if ($Result.outcome -ne "passed" -or $Result.summary.status -ne "success") {
    Fail "packaged pipeline did not complete successfully"
  }
  if ($Result.summary.copiedFiles -ne 3 -or $Result.summary.errors -ne 0) {
    Fail "packaged pipeline summary is unexpected: copied=$($Result.summary.copiedFiles), errors=$($Result.summary.errors)"
  }

  $TicketOutput = Join-Path $OutputDirectory "P1 Packaged Smoke"
  $PdfImage = Join-Path $TicketOutput "brief.png"
  $VisualImage = Join-Path $TicketOutput "visual.png"
  $OutputVideo = Join-Path $TicketOutput "clip.mp4"
  $Report = Join-Path $TicketOutput "report.txt"
  foreach ($OutputFile in @($PdfImage, $VisualImage, $OutputVideo, $Report)) {
    Require-File -Path $OutputFile -Label "pipeline output"
  }
  if (Test-Path -LiteralPath (Join-Path $TicketOutput "brief.pdf")) {
    Fail "PDF original remains after successful conversion"
  }

  $InstalledFfprobe = Join-Path $InstallDirectory "ffprobe.exe"
  Assert-ImageBounds -File $PdfImage
  Assert-ImageBounds -File $VisualImage
  $VideoStream = Read-ProbeStream -Ffprobe $InstalledFfprobe -File $OutputVideo -Selector "v:0" -Entries "stream=codec_name,width,height,pix_fmt"
  if ($VideoStream.codec_name -ne "h264" -or $VideoStream.width -ne 720 -or $VideoStream.height -ne 1280 -or $VideoStream.pix_fmt -ne "yuv420p") {
    Fail "unexpected processed video stream: $($VideoStream.codec_name) $($VideoStream.width)x$($VideoStream.height) $($VideoStream.pix_fmt)"
  }
  $AudioStream = Read-ProbeStream -Ffprobe $InstalledFfprobe -File $OutputVideo -Selector "a:0" -Entries "stream=codec_name"
  if ($AudioStream.codec_name -ne "aac") {
    Fail "expected retained AAC audio, received $($AudioStream.codec_name)"
  }

  $ExpectedReportPaths = @(
    (Normalize-WindowsPathForComparison (Join-Path $SourceDirectory "brief.pdf")),
    (Normalize-WindowsPathForComparison (Join-Path $SourceDirectory "visual.png")),
    (Normalize-WindowsPathForComparison (Join-Path $SourceDirectory "clip.mp4"))
  )
  $ActualReportPaths = @(
    [IO.File]::ReadAllLines($Report) |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      ForEach-Object { Normalize-WindowsPathForComparison $_ }
  )
  if ($ActualReportPaths.Count -ne 3) {
    Fail "ticket report must contain exactly three current-ticket source paths"
  }
  foreach ($ExpectedPath in $ExpectedReportPaths) {
    if (-not ($ActualReportPaths -contains $ExpectedPath)) {
      Fail "ticket report is missing source path: $ExpectedPath"
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($env:HORIZON_TRAVERSAL_SMOKE_REPORT_PATH)) {
    $SmokeReport = [IO.Path]::GetFullPath($env:HORIZON_TRAVERSAL_SMOKE_REPORT_PATH)
    $SmokeReportParent = Split-Path -Parent $SmokeReport
    New-Item -ItemType Directory -Force -Path $SmokeReportParent | Out-Null
    Copy-Item -LiteralPath $ResultPath -Destination $SmokeReport -Force
  }
  if (-not [string]::IsNullOrWhiteSpace($env:HORIZON_TRAVERSAL_INSPECTION_REPORT_PATH)) {
    $InspectionReport = [IO.Path]::GetFullPath($env:HORIZON_TRAVERSAL_INSPECTION_REPORT_PATH)
    $InspectionReportParent = Split-Path -Parent $InspectionReport
    New-Item -ItemType Directory -Force -Path $InspectionReportParent | Out-Null
    Copy-Item -LiteralPath $InspectionPath -Destination $InspectionReport -Force
  }

  Write-Host "Packaged Windows workflow assertions passed: $Installer"
  $SmokeSucceeded = $true
} finally {
  if ($Installed) {
    $Uninstaller = Join-Path $InstallDirectory "uninstall.exe"
    if (Test-Path -LiteralPath $Uninstaller -PathType Leaf) {
      Invoke-NsisProcess -Executable $Uninstaller -Arguments "/S" -Description "NSIS uninstaller"
      Wait-ForPathRemoval -Path $InstallDirectory
    }
    Wait-ForUninstallRegistrationRemoval
    if (@(Get-HorizonUninstallEntries -Hive "CurrentUser").Count -ne 0) {
      Fail "uninstaller left an HKCU uninstall registration"
    }
    if (@(Get-HorizonUninstallEntries -Hive "LocalMachine").Count -ne 0) {
      Fail "uninstaller left an HKLM uninstall registration"
    }
    if (Test-Path -LiteralPath $InstallDirectory) {
      Fail "installation did not provide a working silent uninstaller: $InstallDirectory"
    }
    $UninstallVerified = $true
  }

  if ($env:HORIZON_TRAVERSAL_KEEP_SMOKE_WORKSPACE -eq "1") {
    Write-Host "Kept packaged smoke workspace: $Workspace"
  } elseif (Test-Path -LiteralPath $Workspace) {
    $ExpectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $ActualParent = [IO.Path]::GetFullPath((Split-Path -Parent $Workspace)).TrimEnd('\')
    $Leaf = Split-Path -Leaf $Workspace
    if (-not $ActualParent.Equals($ExpectedParent, [StringComparison]::OrdinalIgnoreCase) -or -not $Leaf.StartsWith("horizon-traversal-package-smoke-")) {
      Fail "refusing to remove unexpected smoke workspace: $Workspace"
    }
    Remove-Item -LiteralPath $Workspace -Recurse -Force
  }
}

if (-not $SmokeSucceeded -or -not $UninstallVerified) {
  Fail "packaged Windows smoke did not complete all assertions and cleanup"
}
