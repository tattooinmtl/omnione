// esptool, driven properly: version-aware command names, an explicit reset
// strategy, and output parsed into facts.
//
// Resetting into the bootloader is esptool's job, not a person's. By default
// it pulses DTR/RTS to pull IO0 low across a reset ("default reset"), which
// is what every board with an auto-reset circuit (two transistors on the
// USB-serial side, or the ESP32-CAM-MB programmer) expects. Chips with
// native USB (S2, S3, C3, C6, H2) reset over USB instead. Only a board with
// no auto-reset circuit at all needs a hand on BOOT, and then the tools say
// so instead of failing vaguely.
//
// esptool 5 renamed its commands and options to kebab-case (flash-id,
// default-reset); 4.x only knows snake_case. Both are built from one table.

import { spawnSync } from 'node:child_process';
import { which } from './toolchains.js';

export const RESETS = {
  auto: 'default_reset',   // DTR/RTS pulse: the usual auto-reset circuit
  usb: 'usb_reset',        // native-USB chips (S2/S3/C3/C6/H2)
  manual: 'no_reset',      // someone holds BOOT/IO0 themselves
};
export const AFTERS = { run: 'hard_reset', stay: 'no_reset' };

export function esptoolPath() {
  return which('esptool') || which('esptool.py');
}

const majorCache = new Map();
export function esptoolMajor(tool) {
  if (majorCache.has(tool)) return majorCache.get(tool);
  let major = 4;
  try {
    const r = spawnSync(tool, ['version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const m = `${r.stdout || ''}${r.stderr || ''}`.match(/v?(\d+)\.\d+/);
    if (m) major = Number(m[1]);
  } catch { /* keep 4: snake_case works on both */ }
  majorCache.set(tool, major);
  return major;
}

const kebab = (s) => s.replace(/_/g, '-');
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/* The command line, for the esptool version at hand. */
export function esptoolCommand({ tool, major = 5, port, command, args = [], reset = 'auto', after = 'run', baud, chip }) {
  const name = (s) => (major >= 5 ? kebab(s) : s);
  const before = RESETS[reset] || RESETS.auto;
  const afterMode = AFTERS[after] || AFTERS.run;
  return [
    q(tool),
    '--port', q(port),
    ...(chip ? ['--chip', q(chip)] : []),
    ...(baud ? ['--baud', String(Number(baud))] : []),
    '--before', name(before),
    '--after', name(afterMode),
    name(command),
    ...args,
  ].join(' ');
}

/* What went wrong, from esptool's output: the port is in use, it isn't
 * there, or the chip never answered (so it never entered download mode). */
export function classifyFailure(text) {
  const t = String(text || '');
  if (/could not open port[^\n]*(access is denied|permission|PermissionError|busy|in use)/i.test(t)
    || /Access is denied|Resource busy|being used by another process/i.test(t)) return 'port_busy';
  if (/could not open port|FileNotFoundError|No such file or directory/i.test(t)) return 'port_missing';
  if (/Failed to connect|No serial data received|Wrong boot mode|Invalid head of packet|Timed out waiting for packet header/i.test(t)) return 'no_bootloader';
  return null;
}

export const FAILURE_HINTS = {
  port_busy: 'Another program has the port open. Run serial_port_owner to see which one, close it, and try again. Holding BOOT will not help with this.',
  port_missing: 'That port is not there. Run board_list: the board may be unplugged or on a different COM number.',
  no_bootloader: 'The chip did not enter download mode on its own (the DTR/RTS auto-reset, then the USB reset, were both tried). This happens on boards without an auto-reset circuit, such as a bare ESP32-CAM without its MB programmer board. Ask the user to hold BOOT (IO0) and tap RESET, then retry with reset: "manual".',
};

/* Facts from esptool output, both 4.x and 5.x wording. */
export function parseChipInfo(text) {
  const t = String(text || '');
  const one = (re) => (t.match(re) || [, null])[1]?.trim() || null;
  const crystal = one(/Crystal frequency:\s*(\d+\s*MHz)/i) || one(/Crystal is\s*(\d+\s*MHz)/i);
  return {
    chip: one(/Chip type:\s*(.+)/i) || one(/Chip is\s*(.+)/i) || one(/Detecting chip type\.*\s*(\S.*)/i),
    features: one(/Features:\s*(.+)/i),
    crystal: crystal ? crystal.replace(/\s+/g, '') : null,
    mac: one(/MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i),
    flash: {
      manufacturer: one(/Manufacturer:\s*([0-9a-f]+)/i),
      device: one(/Device:\s*([0-9a-f]+)/i),
      size: one(/Detected flash size:\s*(\S+)/i),
      voltage: one(/Flash voltage set by[^:]*:\s*(\S+)/i) || one(/Flash voltage set by a strapping pin:\s*(\S+)/i),
    },
  };
}

/* "0x10000", "65536" or 65536 → 65536; anything else → null. */
export function parseAddress(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  const s = String(v ?? '').trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}
export const hex = (n) => `0x${n.toString(16)}`;
export const SECTOR = 0x1000;
