// Board toolchains — what is installed, and what to do about what isn't.
//
// Detection prefers what already exists over installing anything. On this
// machine arduino-cli and esptool are already present in Program Files, and
// reinstalling them through a package manager would leave two copies
// disagreeing about which cores are installed.
//
// Nothing here installs silently. `installCommandFor` returns the command a
// human would run; the agent proposes it and the user approves it through
// the normal `bash` permission gate. Toolchain installs pull hundreds of
// megabytes and sometimes need elevation — not something to do behind
// someone's back.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PROBE_TIMEOUT_MS = 8000;

/* Resolve a command the way the shell would, including PATHEXT on Windows.
 * spawnSync does not apply PATHEXT, so a bare "arduino-cli" is ENOENT even
 * when it is plainly on the PATH. */
export function which(command) {
  if (path.isAbsolute(command)) return existsSync(command) ? command : null;

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try { if (existsSync(candidate)) return candidate; } catch { /* unreadable dir */ }
    }
  }
  return null;
}

/* Run `<cmd> <versionArgs>` and capture the first line. */
function probeVersion(resolved, versionArgs) {
  try {
    const ext = path.extname(resolved).toLowerCase();
    const viaShell = process.platform === 'win32' && (ext === '.cmd' || ext === '.bat');
    const r = viaShell
      ? spawnSync(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', resolved, ...versionArgs],
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true })
      : spawnSync(resolved, versionArgs,
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return text.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

const TOOLS = [
  {
    id: 'arduino-cli',
    command: 'arduino-cli',
    versionArgs: ['version'],
    purpose: 'Compile and upload Arduino, ESP32 and RP2040 sketches.',
    install: {
      win32: 'winget install ArduinoSA.CLI',
      darwin: 'brew install arduino-cli',
      linux: 'curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh',
    },
  },
  {
    id: 'esptool',
    command: 'esptool',
    altCommands: ['esptool.py'],
    versionArgs: ['version'],
    purpose: 'Low-level ESP32 flash: chip id, erase, raw writes.',
    install: {
      win32: 'pip install --upgrade esptool',
      darwin: 'pip3 install --upgrade esptool',
      linux: 'pip3 install --upgrade esptool',
    },
  },
  {
    id: 'platformio',
    command: 'pio',
    altCommands: ['platformio'],
    versionArgs: ['--version'],
    purpose: 'Alternative build system with a wider board and framework matrix (ESP-IDF, Zephyr, STM32).',
    install: {
      win32: 'pip install --upgrade platformio',
      darwin: 'pip3 install --upgrade platformio',
      linux: 'pip3 install --upgrade platformio',
    },
  },
  {
    id: 'mpremote',
    command: 'mpremote',
    versionArgs: ['version'],
    purpose: 'Push files to a MicroPython board and drive its REPL.',
    install: {
      win32: 'pip install --upgrade mpremote',
      darwin: 'pip3 install --upgrade mpremote',
      linux: 'pip3 install --upgrade mpremote',
    },
  },
];

/* What is installed right now. */
export function detectToolchains() {
  const out = [];
  for (const tool of TOOLS) {
    let resolved = which(tool.command);
    let usedCommand = tool.command;
    for (const alt of tool.altCommands || []) {
      if (resolved) break;
      resolved = which(alt);
      if (resolved) usedCommand = alt;
    }
    out.push({
      id: tool.id,
      command: usedCommand,
      purpose: tool.purpose,
      installed: Boolean(resolved),
      path: resolved,
      version: resolved ? probeVersion(resolved, tool.versionArgs) : null,
      installCommand: resolved ? null : (tool.install[process.platform] || tool.install.linux),
    });
  }
  return out;
}

export function getToolchain(id) {
  return detectToolchains().find((t) => t.id === id) || null;
}

export function installCommandFor(id) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) return null;
  return tool.install[process.platform] || tool.install.linux;
}

/* Arduino cores needed per board family, for `arduino-cli core install`. */
export const CORES = {
  esp32: { id: 'esp32:esp32', url: 'https://espressif.github.io/arduino-esp32/package_esp32_index.json' },
  arduino: { id: 'arduino:avr', url: null },
  rp2040: { id: 'rp2040:rp2040', url: 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json' },
  samd: { id: 'arduino:samd', url: null },
};

/* Which cores arduino-cli already has. */
export function installedCores() {
  const cli = which('arduino-cli');
  if (!cli) return { available: false, cores: [] };
  try {
    const r = spawnSync(cli, ['core', 'list', '--format', 'json'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status !== 0) return { available: true, cores: [], error: (r.stderr || '').trim() };
    const parsed = JSON.parse(r.stdout || '{}');
    // arduino-cli changed this shape between versions: older builds return a
    // bare array, newer ones wrap it in { platforms: [...] }.
    const list = Array.isArray(parsed) ? parsed : (parsed.platforms || []);
    return {
      available: true,
      cores: list.map((c) => ({
        id: c.id || c.ID || '',
        installed: c.installed || c.installed_version || '',
        name: c.name || c.Name || '',
      })),
    };
  } catch (e) {
    return { available: true, cores: [], error: e.message };
  }
}

/* What is missing for a given board family, and the commands that would fix
 * it. Returned for a human to approve, never run from here. */
export function requirementsFor(family) {
  const core = CORES[family];
  const steps = [];
  const cli = getToolchain('arduino-cli');

  if (!cli?.installed) {
    steps.push({ what: 'arduino-cli', why: 'needed to compile and upload', command: installCommandFor('arduino-cli') });
  } else if (core) {
    const { cores } = installedCores();
    const have = cores.some((c) => c.id === core.id && c.installed);
    if (!have) {
      if (core.url) {
        steps.push({
          what: `${core.id} board index`,
          why: 'third-party core, so its package index must be registered first',
          command: `arduino-cli config add board_manager.additional_urls ${core.url}`,
        });
        steps.push({ what: 'index refresh', why: 'pick up the new index', command: 'arduino-cli core update-index' });
      }
      steps.push({ what: core.id, why: `board support for ${family}`, command: `arduino-cli core install ${core.id}` });
    }
  }
  return { family, core: core?.id || null, satisfied: steps.length === 0, steps };
}
