# OmniOne installer and updater for Windows.
#
# Install: the personal command from your profile on the website,
#   irm https://omnione.globalwarningnetworks.com/install/<your key> | iex
# installs OmniOne in %USERPROFILE%\.omnione, signed in to your account.
#
# Update: OmniOne.cmd runs this same script (saved as update.ps1, without a
# key) each time OmniOne starts. It asks the website what changed, using the
# app's own account token, and downloads only those files. Nothing else to do.
#
# Your settings, keys, Omi-One's memory and your sessions are never touched.
# Everything runs inside one script block that ends with `return`, never
# `exit`: run through `irm | iex`, `exit` would close your PowerShell window.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $Site = 'https://omnione.globalwarningnetworks.com'
    $Key = ''
    $Installing = $Key -ne ''
    $OmniHome = if ($PSScriptRoot) { $PSScriptRoot } elseif ($env:OMNIONE_DIR) { $env:OMNIONE_DIR } else { Join-Path $HOME '.omnione' }
    $AppDir = Join-Path $OmniHome 'app'
    $StateFile = Join-Path $OmniHome 'installed.json'
    $CloudFile = Join-Path $AppDir '.gwn-cloud.json'
    # Files OmniOne lets you edit: shipped once, then yours.
    $KeepIfPresent = @('mind/SOUL.md', '.gwn-mcp.json')
    $Utf8 = New-Object System.Text.UTF8Encoding $false

    function Say($msg, $color = 'Gray') { Write-Host "  $msg" -ForegroundColor $color }
    function ErrText($err) {
        $m = "$($err.ErrorDetails.Message)"
        try { $j = $m | ConvertFrom-Json; if ($j.message) { return $j.message } } catch { }
        if ($m) { return $m.Trim() }
        return $err.Exception.Message
    }
    function Status($err) { try { return [int]$err.Exception.Response.StatusCode } catch { return 0 } }

    if ($Installing) {
        Write-Host ''
        Say 'OmniOne installer' Cyan
        Say "Into: $OmniHome"
        Write-Host ''

        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { Say 'OmniOne needs Node.js 20 or newer. Install it from https://nodejs.org, then run this again.' Yellow; return }
        $major = [int]((& node -v).TrimStart('v').Split('.')[0])
        if ($major -lt 20) { Say "OmniOne needs Node.js 20 or newer (you have $(& node -v)). Update it from https://nodejs.org." Yellow; return }
    }

    # --- Who is asking: the install key, or this copy's account token ------------
    $cloud = $null
    if (Test-Path $CloudFile) { try { $cloud = [IO.File]::ReadAllText($CloudFile) | ConvertFrom-Json } catch { } }
    if ($Installing) {
        $auth = @{ 'X-Omni-Install' = $Key }
    } elseif ($cloud -and $cloud.token) {
        $auth = @{ 'Authorization' = "Bearer $($cloud.token)" }
    } else {
        Say 'OmniOne is signed out, so it cannot check for updates.' Yellow
        Say "Run your install command from $Site/profile.php again to sign it back in."
        return
    }

    # --- What the website has ----------------------------------------------------
    try {
        $m = Invoke-RestMethod -Uri "$Site/api/source/manifest" -Headers $auth -UseBasicParsing -TimeoutSec 30
    } catch {
        if ($Installing -or (Status $_) -eq 401) { Say "Could not get OmniOne: $(ErrText $_)" Yellow }
        else { Say 'Could not check for updates (offline?). Starting the version you have.' DarkGray }
        return
    }
    $old = $null
    if (Test-Path $StateFile) { try { $old = [IO.File]::ReadAllText($StateFile) | ConvertFrom-Json } catch { } }
    $label = "v$($m.version) (build $($m.build))"
    if (-not $Installing -and $old -and $old.build -eq $m.build -and (Test-Path (Join-Path $AppDir 'node_modules'))) {
        Say "OmniOne $label is up to date." DarkGray
        return
    }
    Say "$(if ($Installing) { 'Installing' } else { 'Updating to' }) OmniOne $label..." Cyan

    # --- Download what changed into a staging folder ---------------------------------
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    $stage = Join-Path $env:TEMP ('omnione-' + [guid]::NewGuid().ToString('N'))
    $todo = @()
    foreach ($f in $m.files) {
        $dest = Join-Path $AppDir ($f.p -replace '/', '\')
        if (Test-Path -LiteralPath $dest) {
            if ($KeepIfPresent -contains $f.p) { continue }
            if ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower() -eq $f.h) { continue }
        }
        $todo += $f
    }
    $lockChanged = @($todo | Where-Object { $_.p -eq 'package-lock.json' }).Count -gt 0
    if ($todo.Count) { Say "Downloading $($todo.Count) file$(if ($todo.Count -ne 1) { 's' })..." }
    $wc = New-Object System.Net.WebClient
    try {
        foreach ($f in $todo) {
            $tmp = Join-Path $stage ($f.p -replace '/', '\')
            New-Item -ItemType Directory -Force -Path (Split-Path $tmp) | Out-Null
            $wc.Headers.Clear()
            foreach ($h in $auth.Keys) { $wc.Headers[$h] = $auth[$h] }
            $wc.DownloadFile("$Site/api/source/file?p=$([uri]::EscapeDataString($f.p))", $tmp)
            if ((Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower() -ne $f.h) { throw "$($f.p) arrived damaged" }
        }
    } catch {
        Say "Download failed: $($_.Exception.Message). Nothing was changed; try again in a minute." Red
        Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
        return
    } finally { $wc.Dispose() }

    # --- Put the new files in place; remove files the new version dropped ------------
    foreach ($f in $todo) {
        $dest = Join-Path $AppDir ($f.p -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        Move-Item -LiteralPath (Join-Path $stage ($f.p -replace '/', '\')) -Destination $dest -Force
    }
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    if ($old -and $old.files) {
        $now = @{}; foreach ($f in $m.files) { $now[$f.p] = 1 }
        foreach ($p in $old.files) {
            if (-not $now.ContainsKey($p) -and $KeepIfPresent -notcontains $p) {
                Remove-Item -LiteralPath (Join-Path $AppDir ($p -replace '/', '\')) -Force -ErrorAction SilentlyContinue
            }
        }
    }

    # --- Dependencies, only when they changed ---------------------------------------------
    if ($lockChanged -or -not (Test-Path (Join-Path $AppDir 'node_modules'))) {
        Say 'Installing dependencies (a minute or two the first time)...'
        Push-Location $AppDir
        try {
            & npm ci --no-audit --no-fund --loglevel=error
            if ($LASTEXITCODE -ne 0) { throw "npm ci exited with $LASTEXITCODE" }
        } catch {
            Pop-Location
            Say "Installing dependencies failed: $_" Red
            return
        }
        Pop-Location
    }
    $state = @{ version = $m.version; build = $m.build; commit = $m.commit; files = @($m.files | ForEach-Object { $_.p }) }
    [IO.File]::WriteAllText($StateFile, ($state | ConvertTo-Json -Depth 3 -Compress), $Utf8)

    # --- Keep this updater itself current ---------------------------------------------------
    try {
        $upd = Invoke-WebRequest -Uri "$Site/install/update.ps1" -UseBasicParsing -TimeoutSec 30
        [IO.File]::WriteAllText((Join-Path $OmniHome 'update.ps1'), $upd.Content, $Utf8)
    } catch { }

    if (-not $Installing) { Say "OmniOne is updated to $label." Green; return }

    # --- Sign this copy in to the account the install key belongs to ------------------------
    $uid = if ($cloud -and $cloud.deviceUid) { "$($cloud.deviceUid)" } else { 'omni-' + (-join ((1..24) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })) }
    $body = @{ key = $Key; device = @{ uid = $uid; name = $env:COMPUTERNAME; os = "Windows $([Environment]::OSVersion.Version)"; app_version = "$($m.version)" } } | ConvertTo-Json -Depth 3
    try {
        $r = Invoke-RestMethod -Method Post -Uri "$Site/api/auth/install" -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 30
        $acct = [ordered]@{ deviceUid = $uid; token = $r.token; user = $r.user; device = $r.device; connectedAt = (Get-Date).ToUniversalTime().ToString('o') }
        [IO.File]::WriteAllText($CloudFile, ($acct | ConvertTo-Json -Depth 4), $Utf8)
        Say "Signed in as $($r.user.email)."
    } catch {
        Say "Installed, but signing in failed: $(ErrText $_). You can connect from OmniOne's account menu." Yellow
    }

    # --- Launcher and Start menu shortcut ----------------------------------------------------
    $launcher = Join-Path $OmniHome 'OmniOne.cmd'
    @"
@echo off
title OmniOne
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
cd /d "%~dp0app"
start "" /min cmd /c "timeout /t 6 >nul && start http://localhost:5174/app"
npm run dev
"@ | Set-Content -Path $launcher -Encoding ASCII
    Remove-Item -LiteralPath (Join-Path $OmniHome 'version.txt') -Force -ErrorAction SilentlyContinue

    if (-not $env:OMNIONE_NO_SHORTCUT) {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\OmniOne.lnk'))
            $lnk.TargetPath = $launcher
            $lnk.WorkingDirectory = $AppDir
            $lnk.Description = 'OmniOne - home of Omi-One'
            $lnk.Save()
            Say 'Added OmniOne to the Start menu.'
        } catch { }
    }

    Write-Host ''
    Say "OmniOne $label is installed." Green
    Say "Start it from the Start menu, or run: $launcher"
    Say 'It keeps itself up to date each time it starts.'
    Write-Host ''
}
