#Requires -Version 5.1

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$FfmpegVersion = "8.1.2"
$FfmpegArchive = "ffmpeg-$FfmpegVersion.tar.xz"
$FfmpegUrl = "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz"
$FfmpegSha256 = "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"

$X264Revision = "b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
$X264Archive = "x264-$X264Revision.tar.bz2"
$X264Url = "https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2"
$X264Sha256 = "6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224"

# The dispatcher verifies and extracts these immutable toolchain inputs before
# invoking this script. They are repeated here so a direct invocation can also
# reject a native-assets.json/tooling mismatch.
$LlvmMingwVersion = "20260616"
$LlvmMingwUrl = "https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-x86_64.zip"
$LlvmMingwSha256 = "b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35"
$Msys2BaseVersion = "20260611"
$Msys2BaseUrl = "https://repo.msys2.org/distrib/x86_64/msys2-base-x86_64-20260611.tar.xz"
$Msys2BaseSha256 = "a2d047e8ee213c3c6a49a8de427eb1069df12207c0422ff1b3cbb5c905c34221"
$MakeVersion = "4.4.1-3"
$MakeUrl = "https://repo.msys2.org/msys/x86_64/make-4.4.1-3-x86_64.pkg.tar.zst"
$MakeSha256 = "af0bdba17f06fe037f0194069adaa31a8fe45f1a11381501896aea1fae37bd5d"
$NasmVersion = "3.02"
$NasmUrl = "https://www.nasm.us/pub/nasm/releasebuilds/3.02/win64/nasm-3.02-win64.zip"
$NasmSha256 = "161d0bfaff53c2f9e9f3e69fd0672323ebabafd1268976a5cec11be92a19aee7"

$TargetTriple = "x86_64-pc-windows-msvc"
$MinimumSystemVersion = "10.0.19045"
$SourceDateEpoch = "1781678760"
$ExpectedBuildScript = "scripts/build-native-windows-x64.ps1"
$FfmpegRelativePath = "src-tauri/binaries/ffmpeg-$TargetTriple.exe"
$FfprobeRelativePath = "src-tauri/binaries/ffprobe-$TargetTriple.exe"

function Fail {
  param([Parameter(Mandatory = $true)][string]$Message)
  throw $Message
}

function Get-RequiredProperty {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $Property = $Object.PSObject.Properties[$Name]
  if ($null -eq $Property) {
    Fail "$Description is missing property $Name"
  }
  return $Property.Value
}

function Assert-Equal {
  param(
    [AllowNull()][object]$Actual,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if ([string]$Actual -cne $Expected) {
    Fail "$Description mismatch: expected $Expected, received $Actual"
  }
}

function Require-EnvironmentDirectory {
  param([Parameter(Mandatory = $true)][string]$Name)

  $Value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    Fail "$Name must be provided by scripts/prepare-ffmpeg.mjs"
  }
  if (-not (Test-Path -LiteralPath $Value -PathType Container)) {
    Fail "$Name is not a directory: $Value"
  }
  return (Resolve-Path -LiteralPath $Value).Path
}

function Require-File {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Fail "$Description is unavailable: $Path"
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  # This script is launched by Windows PowerShell from a pwsh/Node process.
  # Use .NET directly because the inherited module path may not expose utility cmdlets.
  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    $HashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      $Digest = $HashAlgorithm.ComputeHash($Stream)
      return [System.BitConverter]::ToString($Digest).Replace("-", "").ToLowerInvariant()
    }
    finally {
      $HashAlgorithm.Dispose()
    }
  }
  finally {
    $Stream.Dispose()
  }
}

function Download-Verified {
  param(
    [Parameter(Mandatory = $true)][System.Net.Http.HttpClient]$Client,
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  for ($Attempt = 1; $Attempt -le 3; $Attempt += 1) {
    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Force
    }
    try {
      Write-Host "Downloading $Url"
      $Response = $Client.GetAsync(
        $Url,
        [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
      ).GetAwaiter().GetResult()
      try {
        if (-not $Response.IsSuccessStatusCode) {
          Fail "download failed with HTTP $([int]$Response.StatusCode): $Url"
        }
        if ($Response.RequestMessage.RequestUri.Scheme -cne "https") {
          Fail "download redirected away from HTTPS: $($Response.RequestMessage.RequestUri)"
        }

        $InputStream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        try {
          $OutputStream = [System.IO.File]::Open(
            $Destination,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
          )
          try {
            $InputStream.CopyTo($OutputStream)
          }
          finally {
            $OutputStream.Dispose()
          }
        }
        finally {
          $InputStream.Dispose()
        }
      }
      finally {
        $Response.Dispose()
      }

      $ActualSha256 = Get-Sha256 $Destination
      if ($ActualSha256 -cne $ExpectedSha256) {
        Fail "$(Split-Path -Leaf $Destination) checksum mismatch: expected $ExpectedSha256, received $ActualSha256"
      }
      return
    }
    catch {
      if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Force
      }
      if ($Attempt -eq 3) {
        throw
      }
      Write-Warning "Download attempt $Attempt failed; retrying."
    }
  }
}

function Convert-ToMsysPath {
  param(
    [Parameter(Mandatory = $true)][string]$Cygpath,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $Result = & $Cygpath -u -- $Path 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail "cygpath could not convert $Path`: $($Result -join [Environment]::NewLine)"
  }
  return ($Result -join "").Trim()
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$Program,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $Output = @(& $Program @Arguments 2>&1)
  $ExitCode = $LASTEXITCODE
  if ($ExitCode -ne 0) {
    $ExitCodeHex = ([int32]$ExitCode).ToString(
      "X8",
      [Globalization.CultureInfo]::InvariantCulture
    )
    $Details = ($Output -join [Environment]::NewLine).Trim()
    if ([string]::IsNullOrWhiteSpace($Details)) {
      $Details = "no native output"
    }
    $ArgumentSummary = $Arguments -join " "
    Fail "$(Split-Path -Leaf $Program) failed with exit code $ExitCode (0x$ExitCodeHex) while running [$ArgumentSummary]: $Details"
  }
  return ($Output -join [Environment]::NewLine)
}

function Assert-SystemImports {
  param(
    [Parameter(Mandatory = $true)][string]$ReadObj,
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][string[]]$AllowedNames,
    [Parameter(Mandatory = $true)][string[]]$DeniedNames,
    [Parameter(Mandatory = $true)][bool]$DiscoverImports
  )

  $Imports = Invoke-NativeCapture $ReadObj @("--coff-imports", $Binary)
  $Names = [regex]::Matches($Imports, "(?m)^\s*Name:\s*(\S+\.dll)\s*$")
  if ($Names.Count -eq 0) {
    Fail "$(Split-Path -Leaf $Binary) did not expose an inspectable PE import table"
  }
  $NormalizedAllowedNames = @(
    $AllowedNames | ForEach-Object { $_.ToLowerInvariant() }
  )
  $NormalizedDeniedNames = @(
    $DeniedNames | ForEach-Object { $_.ToLowerInvariant() }
  )
  $ImportedNames = @()
  foreach ($Match in $Names) {
    $Name = $Match.Groups[1].Value
    $ImportedNames += $Name
    $Normalized = $Name.ToLowerInvariant()
    if ($NormalizedDeniedNames -contains $Normalized) {
      Fail "$(Split-Path -Leaf $Binary) imports forbidden runtime $Name"
    }
    $IsWindowsApiSet = $Normalized.StartsWith("api-ms-win-") -or
      $Normalized.StartsWith("ext-ms-win-")
    if (-not $IsWindowsApiSet -and
        -not ($NormalizedAllowedNames -contains $Normalized)) {
      if (-not $DiscoverImports) {
        Fail "$(Split-Path -Leaf $Binary) imports undeclared runtime $Name"
      }
    }
  }
  Write-Host "  $(Split-Path -Leaf $Binary) imports: $($ImportedNames -join ', ')"
}

function Assert-Binary {
  param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][string]$Program,
    [Parameter(Mandatory = $true)][string]$ReadObj,
    [AllowEmptyString()][string]$ManifestCompiler,
    [Parameter(Mandatory = $true)][string[]]$AllowedImports,
    [Parameter(Mandatory = $true)][string[]]$DeniedImports,
    [Parameter(Mandatory = $true)][bool]$DiscoverImports
  )

  $Headers = Invoke-NativeCapture $ReadObj @("--file-headers", $Binary)
  if ($Headers -notmatch "Machine:\s+IMAGE_FILE_MACHINE_AMD64\s+\(0x8664\)") {
    Fail "$Program is not an x86-64 PE executable"
  }

  # Reject undeclared loader dependencies before attempting to execute the PE.
  Assert-SystemImports $ReadObj $Binary $AllowedImports $DeniedImports $DiscoverImports

  $VersionOutput = Invoke-NativeCapture $Binary @("-hide_banner", "-version")
  if (-not $VersionOutput.StartsWith("$Program version $FfmpegVersion")) {
    Fail "$Program did not report pinned version $FfmpegVersion"
  }
  if (-not [string]::IsNullOrWhiteSpace($ManifestCompiler) -and
      -not $VersionOutput.Contains("built with $ManifestCompiler")) {
    Fail "$Program was not built with manifest compiler $ManifestCompiler"
  }
  foreach ($Option in @(
      "--enable-gpl",
      "--enable-libx264",
      "--enable-static",
      "--disable-shared",
      "--disable-autodetect",
      "--disable-network"
    )) {
    if (-not $VersionOutput.Contains($Option)) {
      Fail "$Program was not built with required configuration $Option"
    }
  }
}

$NativeArchitecture = if ([string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
  $env:PROCESSOR_ARCHITECTURE
}
else {
  $env:PROCESSOR_ARCHITEW6432
}
if ($NativeArchitecture -cne "AMD64") {
  Fail "this builder requires native Windows x64; received $NativeArchitecture"
}

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDirectory ".."))
$ManifestPath = Join-Path $RepositoryRoot "src-tauri\native-assets.json"
Require-File $ManifestPath "native asset manifest"

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$ManifestFfmpeg = Get-RequiredProperty $Manifest.sources "ffmpeg" "native source manifest"
$ManifestX264 = Get-RequiredProperty $Manifest.sources "x264" "native source manifest"
Assert-Equal $ManifestFfmpeg.version $FfmpegVersion "FFmpeg version pin"
Assert-Equal $ManifestFfmpeg.url $FfmpegUrl "FFmpeg URL pin"
Assert-Equal $ManifestFfmpeg.sha256 $FfmpegSha256 "FFmpeg checksum pin"
Assert-Equal $ManifestX264.revision $X264Revision "x264 revision pin"
Assert-Equal $ManifestX264.url $X264Url "x264 URL pin"
Assert-Equal $ManifestX264.sha256 $X264Sha256 "x264 checksum pin"

$ManifestToolchains = Get-RequiredProperty $Manifest "toolchains" "native asset manifest"
$WindowsToolchains = Get-RequiredProperty $ManifestToolchains $TargetTriple "native toolchain manifest"
foreach ($Toolchain in @(
    @("llvmMingw", $LlvmMingwVersion, $LlvmMingwUrl, $LlvmMingwSha256),
    @("msys2Base", $Msys2BaseVersion, $Msys2BaseUrl, $Msys2BaseSha256),
    @("make", $MakeVersion, $MakeUrl, $MakeSha256),
    @("nasm", $NasmVersion, $NasmUrl, $NasmSha256)
  )) {
  $ManifestToolchain = Get-RequiredProperty $WindowsToolchains $Toolchain[0] "Windows toolchain manifest"
  Assert-Equal $ManifestToolchain.version $Toolchain[1] "$($Toolchain[0]) version pin"
  Assert-Equal $ManifestToolchain.url $Toolchain[2] "$($Toolchain[0]) URL pin"
  Assert-Equal $ManifestToolchain.sha256 $Toolchain[3] "$($Toolchain[0]) checksum pin"
}

$ManifestTargets = Get-RequiredProperty $Manifest "targets" "native asset manifest"
$ManifestTarget = Get-RequiredProperty $ManifestTargets $TargetTriple "native target manifest"
Assert-Equal $ManifestTarget.mediaBuild.script $ExpectedBuildScript "Windows build script"
Assert-Equal $ManifestTarget.mediaBuild.minimumSystemVersion $MinimumSystemVersion "minimum Windows version"
Assert-Equal $ManifestTarget.mediaBuild.sourceDateEpoch $SourceDateEpoch "SOURCE_DATE_EPOCH"
Assert-Equal $ManifestTarget.ffmpeg.path $FfmpegRelativePath "FFmpeg Tauri path"
Assert-Equal $ManifestTarget.ffprobe.path $FfprobeRelativePath "FFprobe Tauri path"

$ManifestCompiler = [string]$ManifestTarget.mediaBuild.compiler
$AllowedImports = @($ManifestTarget.dynamicDependencies.allowedNames)
$DeniedImports = @($ManifestTarget.dynamicDependencies.deniedNames)

$LlvmRoot = Require-EnvironmentDirectory "HORIZON_TRAVERSAL_LLVM_MINGW_ROOT"
$MsysRoot = Require-EnvironmentDirectory "HORIZON_TRAVERSAL_MSYS2_ROOT"
$NasmRoot = Require-EnvironmentDirectory "HORIZON_TRAVERSAL_NASM_ROOT"
$WorkDirectory = Require-EnvironmentDirectory "HORIZON_TRAVERSAL_NATIVE_WORK_DIR"
$OutputDirectoryValue = $env:HORIZON_TRAVERSAL_NATIVE_OUTPUT_DIR
if ([string]::IsNullOrWhiteSpace($OutputDirectoryValue)) {
  $OutputDirectory = Join-Path $RepositoryRoot "src-tauri\binaries"
}
else {
  $OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectoryValue)
}

$Bash = Join-Path $MsysRoot "usr\bin\bash.exe"
$Cygpath = Join-Path $MsysRoot "usr\bin\cygpath.exe"
$Make = Join-Path $MsysRoot "usr\bin\make.exe"
$Clang = Join-Path $LlvmRoot "bin\x86_64-w64-mingw32-clang.exe"
$ReadObj = Join-Path $LlvmRoot "bin\llvm-readobj.exe"
$Nasm = Join-Path $NasmRoot "nasm.exe"
foreach ($Required in @(
    @($Bash, "pinned MSYS2 bash"),
    @($Cygpath, "pinned MSYS2 cygpath"),
    @($Make, "pinned MSYS2 Make"),
    @($Clang, "pinned LLVM-MinGW compiler"),
    @($ReadObj, "pinned LLVM PE inspector"),
    @($Nasm, "pinned NASM assembler")
  )) {
  Require-File $Required[0] $Required[1]
}

$CompilerVersion = Invoke-NativeCapture $Clang @("--version")
$CompilerLine = ($CompilerVersion -split "`r?`n")[0]
$MakeOutput = Invoke-NativeCapture $Make @("--version")
if (-not $MakeOutput.StartsWith("GNU Make 4.4.1")) {
  Fail "pinned Make package reported an unexpected version"
}
$NasmOutput = Invoke-NativeCapture $Nasm @("-v")
if (-not $NasmOutput.StartsWith("NASM version 3.02")) {
  Fail "pinned NASM archive reported an unexpected version"
}
Write-Host "Using $CompilerLine"

$JobsValue = if ([string]::IsNullOrWhiteSpace($env:JOBS)) {
  [Environment]::ProcessorCount.ToString()
}
else {
  $env:JOBS
}
$Jobs = 0
if (-not [int]::TryParse($JobsValue, [ref]$Jobs) -or $Jobs -le 0) {
  Fail "JOBS must be a positive integer"
}

$DownloadDirectory = Join-Path $WorkDirectory "downloads"
$BuildDirectory = Join-Path $WorkDirectory "clean-build"
foreach ($Directory in @(
    $DownloadDirectory,
    $BuildDirectory
  )) {
  if (Test-Path -LiteralPath $Directory) {
    Fail "refusing to reuse native build path: $Directory"
  }
}
New-Item -ItemType Directory -Path $DownloadDirectory | Out-Null

$HttpClient = New-Object System.Net.Http.HttpClient
$HttpClient.DefaultRequestHeaders.UserAgent.ParseAdd("Horizon-Traversal-native-builder/1")
try {
  $FfmpegSourceArchive = Join-Path $DownloadDirectory $FfmpegArchive
  $X264SourceArchive = Join-Path $DownloadDirectory $X264Archive
  Download-Verified $HttpClient $FfmpegUrl $FfmpegSourceArchive $FfmpegSha256
  Download-Verified $HttpClient $X264Url $X264SourceArchive $X264Sha256
}
finally {
  $HttpClient.Dispose()
}

$BuildScriptPath = Join-Path $WorkDirectory "build-windows.sh"
$BuildScript = @'
#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export TZ=UTC
export SOURCE_DATE_EPOCH="$HORIZON_SOURCE_DATE_EPOCH"
export ZERO_AR_DATE=1
export PATH="$HORIZON_LLVM_ROOT/bin:$HORIZON_NASM_ROOT:$HORIZON_MSYS_ROOT/usr/bin"
umask 022

# Keep tool names, rather than temporary absolute paths, in FFmpeg's embedded
# configuration string. PATH contains only the checksum-verified tool roots.
CC=x86_64-w64-mingw32-clang
CXX=x86_64-w64-mingw32-clang++
AR=llvm-ar
RANLIB=llvm-ranlib
STRIP=llvm-strip
NM=llvm-nm
STRINGS=llvm-strings
AS=nasm
MAKE=/usr/bin/make.exe

for tool in "$CC" "$CXX" "$AR" "$RANLIB" "$STRIP" "$NM" "$STRINGS" "$AS" "$MAKE"; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'error: required build tool is unavailable: %s\n' "$tool" >&2
    exit 1
  }
done

tar -xJf "$HORIZON_DOWNLOAD_ROOT/ffmpeg-8.1.2.tar.xz" -C "$HORIZON_SOURCE_ROOT"
tar -xjf "$HORIZON_DOWNLOAD_ROOT/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2" -C "$HORIZON_SOURCE_ROOT"

REPRODUCIBLE_CFLAGS="-O2 -fno-ident -ffunction-sections -fdata-sections -D_WIN32_WINNT=0x0A00 -DWINVER=0x0A00"
REPRODUCIBLE_LDFLAGS="-static -Wl,--gc-sections -Wl,--no-insert-timestamp -Wl,--major-os-version,10 -Wl,--minor-os-version,0 -Wl,--major-subsystem-version,10 -Wl,--minor-subsystem-version,0"
export CC CXX AR RANLIB STRIP NM STRINGS AS
export ARFLAGS=rcD

printf 'Building x264 revision %s\n' 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55'
(
  cd "$HORIZON_SOURCE_ROOT/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
  CFLAGS="$REPRODUCIBLE_CFLAGS" \
  LDFLAGS="$REPRODUCIBLE_LDFLAGS" \
    ./configure \
      --prefix="$HORIZON_X264_PREFIX" \
      --host=x86_64-w64-mingw32 \
      --cross-prefix=x86_64-w64-mingw32- \
      --enable-static \
      --disable-cli \
      --disable-opencl \
      --disable-lavf \
      --disable-swscale \
      --disable-ffms \
      --disable-gpac \
      --bit-depth=8 \
      --extra-cflags="$REPRODUCIBLE_CFLAGS" \
      --extra-ldflags="$REPRODUCIBLE_LDFLAGS"
  "$MAKE" -j"$HORIZON_JOBS"
  "$MAKE" install-lib-static
)

# FFmpeg's libx264 check goes through this deliberately narrow replacement for
# pkg-config. It can only disclose the checksum-verified static x264 prefix.
cat >"$HORIZON_BUILD_ROOT/pkg-config-x264" <<'PKG_CONFIG_EOF'
#!/usr/bin/env bash
set -euo pipefail

mode=
package_seen=0
for argument in "$@"; do
  case "$argument" in
    --version) mode=version ;;
    --exists|--print-errors|--static) ;;
    --cflags|--cflags-only-I) mode=cflags ;;
    --libs) mode=libs ;;
    --variable=includedir) mode=includedir ;;
    x264|x264\ *) package_seen=1 ;;
  esac
done

if test "$mode" = version; then
  printf '%s\n' 'horizon-traversal-pkg-config-shim 1'
  exit 0
fi
test "$package_seen" = 1 || exit 1
case "$mode" in
  '') exit 0 ;;
  cflags) printf '%s\n' '-I../../x264-prefix/include' ;;
  includedir) printf '%s\n' '../../x264-prefix/include' ;;
  libs) printf '%s\n' '-L../../x264-prefix/lib -lx264' ;;
  *) exit 1 ;;
esac
PKG_CONFIG_EOF
chmod 0755 "$HORIZON_BUILD_ROOT/pkg-config-x264"

printf 'Building FFmpeg %s\n' '8.1.2'
(
  cd "$HORIZON_SOURCE_ROOT/ffmpeg-8.1.2"
  ./configure \
    --prefix=/usr/local \
    --arch=x86_64 \
    --target-os=mingw32 \
    --cross-prefix=x86_64-w64-mingw32- \
    --cc="$CC" \
    --cxx="$CXX" \
    --ar="$AR" \
    --ranlib="$RANLIB" \
    --strip="$STRIP" \
    --nm="$NM" \
    --pkg-config=../../pkg-config-x264 \
    --pkg-config-flags=--static \
    --enable-gpl \
    --enable-libx264 \
    --enable-static \
    --disable-shared \
    --disable-autodetect \
    --disable-debug \
    --disable-doc \
    --disable-network \
    --disable-ffplay \
    --enable-ffmpeg \
    --enable-ffprobe \
    --extra-cflags="$REPRODUCIBLE_CFLAGS -I../../x264-prefix/include" \
    --extra-ldflags="$REPRODUCIBLE_LDFLAGS -L../../x264-prefix/lib"
  "$MAKE" -j"$HORIZON_JOBS" ffmpeg.exe ffprobe.exe
)

for program in ffmpeg ffprobe; do
  source_binary="$HORIZON_SOURCE_ROOT/ffmpeg-8.1.2/${program}.exe"
  staged_binary="$HORIZON_STAGING_ROOT/${program}-x86_64-pc-windows-msvc.exe"
  # FFmpeg's Makefile already strips this executable from its *_g.exe output.
  install -m 0755 "$source_binary" "$staged_binary"
done
'@
$Utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
[System.IO.File]::WriteAllText(
  $BuildScriptPath,
  $BuildScript.Replace("`r`n", "`n"),
  $Utf8NoBom
)

$env:CHERE_INVOKING = "1"
$env:MSYSTEM = "MSYS"
$env:HORIZON_DOWNLOAD_ROOT = Convert-ToMsysPath $Cygpath $DownloadDirectory
$env:HORIZON_LLVM_ROOT = Convert-ToMsysPath $Cygpath $LlvmRoot
$env:HORIZON_MSYS_ROOT = Convert-ToMsysPath $Cygpath $MsysRoot
$env:HORIZON_NASM_ROOT = Convert-ToMsysPath $Cygpath $NasmRoot
$env:HORIZON_JOBS = $Jobs.ToString()
$env:HORIZON_SOURCE_DATE_EPOCH = $SourceDateEpoch
$BuildScriptMsys = Convert-ToMsysPath $Cygpath $BuildScriptPath

function Invoke-CleanMediaBuild {
  param(
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if (Test-Path -LiteralPath $BuildRoot) {
    Fail "refusing to reuse native build path: $BuildRoot"
  }
  $SourceRoot = Join-Path $BuildRoot "sources"
  $PrefixRoot = Join-Path $BuildRoot "x264-prefix"
  $StagingRoot = Join-Path $BuildRoot "staging"
  foreach ($Directory in @($BuildRoot, $SourceRoot, $PrefixRoot, $StagingRoot)) {
    New-Item -ItemType Directory -Path $Directory | Out-Null
  }

  $env:HORIZON_BUILD_ROOT = Convert-ToMsysPath $Cygpath $BuildRoot
  $env:HORIZON_SOURCE_ROOT = Convert-ToMsysPath $Cygpath $SourceRoot
  $env:HORIZON_X264_PREFIX = Convert-ToMsysPath $Cygpath $PrefixRoot
  $env:HORIZON_STAGING_ROOT = Convert-ToMsysPath $Cygpath $StagingRoot

  Write-Host "Starting $Description from clean source and build trees."
  & $Bash --noprofile --norc $BuildScriptMsys
  if ($LASTEXITCODE -ne 0) {
    Fail "$Description failed with status $LASTEXITCODE"
  }
}

$StagingDirectory = Join-Path $BuildDirectory "staging"
Invoke-CleanMediaBuild $BuildDirectory "native media build"
$StagedFfmpeg = Join-Path $StagingDirectory "ffmpeg-$TargetTriple.exe"
$StagedFfprobe = Join-Path $StagingDirectory "ffprobe-$TargetTriple.exe"
Require-File $StagedFfmpeg "FFmpeg build"
Require-File $StagedFfprobe "FFprobe build"

Assert-Binary $StagedFfmpeg "ffmpeg" $ReadObj $ManifestCompiler $AllowedImports $DeniedImports $false
Assert-Binary $StagedFfprobe "ffprobe" $ReadObj $ManifestCompiler $AllowedImports $DeniedImports $false

$EncoderOutput = Invoke-NativeCapture $StagedFfmpeg @("-hide_banner", "-encoders")
if ($EncoderOutput -notmatch "(?m)^\s*[VAS]\S{5}\s+libx264\s") {
  Fail "the FFmpeg build does not contain the libx264 encoder"
}
if ($EncoderOutput -notmatch "(?m)^\s*[VAS]\S{5}\s+aac\s") {
  Fail "the FFmpeg build does not contain the AAC encoder"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
foreach ($Program in @("ffmpeg", "ffprobe")) {
  $StagedBinary = Join-Path $StagingDirectory "$Program-$TargetTriple.exe"
  $Destination = Join-Path $OutputDirectory "$Program-$TargetTriple.exe"
  Move-Item -LiteralPath $StagedBinary -Destination $Destination -Force
  Write-Host "Prepared $Destination ($(Get-Sha256 $Destination))"
}

Write-Host "Native media tools are ready for $TargetTriple."
