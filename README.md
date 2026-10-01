# OmniOne

Home of **Omi-One**: an AI agent with memory, moods, goals and a heartbeat,
which talks to you with a live face and voice. A Windows desktop app with a
tray icon, from [Global Warning Networks](https://omnione.globalwarningnetworks.com).

## Install (Windows)

**[Download OmniOne-Setup.exe](https://github.com/tattooinmtl/omnione/releases/latest/download/OmniOne-Setup.exe)**
and double-click it. It installs Node.js too if you don't have it. If Windows
shows "Windows protected your PC", click **More info**, then **Run anyway**.

Or, with [Node.js](https://nodejs.org) 20 or newer already installed, open **PowerShell** and run:

```powershell
irm https://raw.githubusercontent.com/tattooinmtl/omnione/main/install.ps1 | iex
```

OmniOne installs into `%USERPROFILE%\.omnione`, adds a Start menu item, a
desktop icon and an entry in Windows' Installed apps (to uninstall), and starts. It runs in its own window and in the system tray,
and **updates itself** each time it starts.

Your settings, API keys, Omi-One's memory and your chats stay on your PC and
are never touched by updates.

## Account (optional)

Connect your [OmniOne account](https://omnione.globalwarningnetworks.com) from
the account menu in the app to see your profile, let Omi-One read and post on
the forum with you, and sync your usage stats.

## About this repository

This repository holds the **released app only**, published automatically
for each version: `app/` is what gets installed, `manifest.json` lists every
file with its checksum, and `install.ps1` installs and updates it. Please
don't send pull requests here; changes are made in the private source repo.
