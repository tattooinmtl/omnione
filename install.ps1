# OmniOne installer and updater for Windows.
#
# Install (like Omni and OmniBots):
#   irm https://raw.githubusercontent.com/tattooinmtl/omnione/main/install.ps1 | iex
# installs OmniOne in %USERPROFILE%\.omnione from the public distribution
# repo github.com/tattooinmtl/omnione (the finished app only; the source is
# private). No account needed to install; connect one from OmniOne's account
# menu for the website features (profile, forum, usage sync).
#
# Update: OmniOne.exe runs this same script (saved as update.ps1) each time it
# starts. It reads manifest.json from the latest commit of the distribution
# repo and downloads only the files that changed.
#
# Your settings, keys, Omi-One's memory and your chats are never touched.
# Everything runs inside one script block that ends with `return`, never
# `exit`: run through `irm | iex`, `exit` would close your PowerShell window.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $Repo = if ($env:OMNIONE_REPO) { $env:OMNIONE_REPO } else { 'tattooinmtl/omnione' }
    $Branch = 'main'
    # Run from a file (update.ps1 next to app\) = updating; piped into iex = installing.
    $Installing = -not $PSScriptRoot
    $OmniHome = if ($PSScriptRoot) { $PSScriptRoot } elseif ($env:OMNIONE_DIR) { $env:OMNIONE_DIR } else { Join-Path $HOME '.omnione' }
    $AppDir = Join-Path $OmniHome 'app'
    $StateFile = Join-Path $OmniHome 'installed.json'
    # Files OmniOne lets you edit: shipped once, then yours.
    $KeepIfPresent = @('mind/SOUL.md', '.gwn-mcp.json')
    $Utf8 = New-Object System.Text.UTF8Encoding $false
    $Headers = @{ 'User-Agent' = 'OmniOne-installer' }

    function Say($msg, $color = 'Gray') { Write-Host "  $msg" -ForegroundColor $color }

    # The Start menu shortcut opens app\bin\OmniOne.exe: the window, the tray
    # icon and the updates. Rewritten on every update, so changes to how
    # OmniOne starts arrive with the update. Older launchers are removed.
    $Exe = Join-Path $AppDir 'bin\OmniOne.exe'
    function Write-Launchers([switch]$Shortcut) {
        foreach ($oldLauncher in 'OmniOne.vbs', 'OmniOne.cmd') {
            Remove-Item -LiteralPath (Join-Path $OmniHome $oldLauncher) -Force -ErrorAction SilentlyContinue
        }
        # A Start menu item and a desktop icon. Installing creates both; an
        # update only refreshes the ones that still exist (a deleted desktop
        # icon stays deleted).
        $places = @(
            @{ Path = (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\OmniOne.lnk'); Name = 'the Start menu' },
            @{ Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'OmniOne.lnk'); Name = 'the desktop' }
        )
        $added = @()
        foreach ($place in $places) {
            if (-not $Shortcut -and -not (Test-Path $place.Path)) { continue }
            if ($Shortcut -and $env:OMNIONE_NO_DESKTOP -and $place.Name -eq 'the desktop') { continue }
            try {
                $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($place.Path)
                $lnk.TargetPath = $Exe
                $lnk.Arguments = ''
                $lnk.WorkingDirectory = $AppDir
                $lnk.IconLocation = "$Exe,0"
                $lnk.Description = 'OmniOne - home of Omi-One'
                $lnk.Save()
                $added += $place.Name
            } catch { }
        }
        if ($Shortcut -and $added.Count) { Say "Added OmniOne to $($added -join ' and ')." }
    }

    # Windows' "Installed apps" entry (per user, no administrator needed).
    # Uninstall runs OmniOne.exe --uninstall, which asks first.
    function Register-App($version) {
        if (-not (Test-Path $Exe)) { return }
        try {
            $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniOne'
            New-Item -Path $key -Force | Out-Null
            $size = 0
            try { $size = [int]((Get-ChildItem -LiteralPath $AppDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1KB) } catch { }
            $values = [ordered]@{
                DisplayName = 'OmniOne'; DisplayVersion = "$version"; Publisher = 'Global Warning Networks'
                DisplayIcon = "$Exe,0"; InstallLocation = $OmniHome
                UninstallString = "`"$Exe`" --uninstall"; URLInfoAbout = 'https://omnione.globalwarningnetworks.com'
            }
            foreach ($k in $values.Keys) { Set-ItemProperty -Path $key -Name $k -Value $values[$k] }
            foreach ($k in 'NoModify', 'NoRepair') { Set-ItemProperty -Path $key -Name $k -Value 1 -Type DWord }
            if ($size) { Set-ItemProperty -Path $key -Name EstimatedSize -Value $size -Type DWord }
        } catch { }
    }

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

    # --- The latest release: pinned to one commit, so every file matches -----------
    try {
        $sha = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers $Headers -UseBasicParsing -TimeoutSec 30).sha
    } catch {
        $sha = $Branch # API busy or rate-limited: the branch works too, just without the pin
    }
    $Raw = "https://raw.githubusercontent.com/$Repo/$sha"
    try {
        $m = Invoke-RestMethod -Uri "$Raw/manifest.json" -Headers $Headers -UseBasicParsing -TimeoutSec 30
    } catch {
        if ($Installing) { Say "Could not reach GitHub: $($_.Exception.Message)" Yellow }
        else { Say 'Could not check for updates (offline?). Starting the version you have.' DarkGray }
        return
    }
    $old = $null
    if (Test-Path $StateFile) { try { $old = [IO.File]::ReadAllText($StateFile) | ConvertFrom-Json } catch { } }
    $label = "v$($m.version) (build $($m.build))"
    if (-not $Installing) { Write-Launchers }
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
            $url = "$Raw/app/" + (($f.p -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/')
            $wc.Headers['User-Agent'] = 'OmniOne-installer'
            $wc.DownloadFile($url, $tmp)
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
        $src = Join-Path $stage ($f.p -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        try {
            Move-Item -LiteralPath $src -Destination $dest -Force
        } catch {
            # A running program (OmniOne.exe itself) can't be overwritten, but
            # it can be renamed: move it aside and put the new one in place.
            $aside = (Split-Path $dest -Leaf) + '.old-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
            Rename-Item -LiteralPath $dest -NewName $aside -Force
            Move-Item -LiteralPath $src -Destination $dest -Force
        }
    }
    # Leftovers from earlier swaps, now free to delete.
    Get-ChildItem -Path (Join-Path $AppDir 'bin') -Filter '*.old-*' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
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
    # --- The app's screens: built here, only when they changed -------------------------------
    $uiChanged = @($todo | Where-Object { $_.p -match '^(src/|public/|index\.html$|vite\.config\.js$|package(-lock)?\.json$)' }).Count -gt 0
    if ($uiChanged -or -not (Test-Path (Join-Path $AppDir 'dist\index.html'))) {
        Say 'Building the app (a few seconds)...'
        Push-Location $AppDir
        try {
            # Through cmd.exe: Windows PowerShell 5 treats any warning a tool
            # prints on stderr as a failure; only the exit code counts here.
            & cmd.exe /d /c "npm run build >nul 2>&1"
            if ($LASTEXITCODE -ne 0) { throw "npm run build exited with $LASTEXITCODE" }
        } catch {
            Pop-Location
            Say "Building the app failed: $_" Red
            return
        }
        Pop-Location
    }

    $state = @{ version = $m.version; build = $m.build; commit = $m.commit; files = @($m.files | ForEach-Object { $_.p }) }
    [IO.File]::WriteAllText($StateFile, ($state | ConvertTo-Json -Depth 3 -Compress), $Utf8)

    # --- Keep this updater itself current ---------------------------------------------------
    try {
        $upd = Invoke-WebRequest -Uri "$Raw/install.ps1" -Headers $Headers -UseBasicParsing -TimeoutSec 30
        [IO.File]::WriteAllText((Join-Path $OmniHome 'update.ps1'), $upd.Content, $Utf8)
    } catch { }

    if (-not $Installing) {
        # Keep the Installed apps entry current (version, size), if there is one.
        if (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniOne') { Register-App $m.version }
        Say "OmniOne is updated to $label." Green
        return
    }

    Write-Launchers -Shortcut:(-not $env:OMNIONE_NO_SHORTCUT)
    if (-not $env:OMNIONE_NO_SHORTCUT) { Register-App $m.version }
    Remove-Item -LiteralPath (Join-Path $OmniHome 'version.txt') -Force -ErrorAction SilentlyContinue

    Write-Host ''
    Say "OmniOne $label is installed." Green
    Say 'It opens in its own window, lives in the system tray (Omi-One''s face, bottom right)'
    Say 'and keeps itself up to date. Start it any time from the Start menu: OmniOne.'
    Say 'To use the website features, connect your account from the account menu in OmniOne.'
    Write-Host ''
    if (-not (Test-Path $Exe)) {
        Say 'OmniOne.exe is missing from this release; tell the OmniOne team.' Yellow
    } elseif (-not $env:OMNIONE_NO_LAUNCH) {
        Say 'Starting OmniOne...'
        Start-Process -FilePath $Exe -WorkingDirectory $AppDir
    }
}
