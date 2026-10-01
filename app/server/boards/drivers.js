// USB-serial driver status.
//
// A board plugged into a Windows machine with no driver for its bridge chip
// enumerates as an unknown device with no COM port, and every tool then
// reports "no board found" — which is true and useless. This tells the
// difference between "nothing is plugged in" and "something is plugged in
// that Windows cannot talk to".
//
// This module never installs anything. Driver installation needs elevation,
// replaces a system component, and occasionally bricks a working setup; the
// agent's job is to identify the problem precisely and hand the user the
// vendor's own download link. Silent elevation is out of the question, and
// so is downloading an installer and running it on the user's behalf.

import { spawnSync } from 'node:child_process';

const QUERY_TIMEOUT_MS = 15000;

/* Vendor driver packages, by the `driver` key in the detect.js id table. */
export const DRIVER_PACKAGES = {
  cp210x: {
    name: 'Silicon Labs CP210x VCP driver',
    chips: 'CP2102, CP2104, CP2105',
    url: 'https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers',
    linuxNote: 'Built into the mainline kernel as cp210x — no install needed.',
  },
  ch34x: {
    name: 'WCH CH34x VCP driver',
    chips: 'CH340, CH341, CH9102',
    url: 'https://www.wch-ic.com/downloads/CH341SER_EXE.html',
    linuxNote: 'Built into the mainline kernel as ch341 — no install needed.',
  },
  ftdi: {
    name: 'FTDI VCP driver',
    chips: 'FT232R, FT231X',
    url: 'https://ftdichip.com/drivers/vcp-drivers/',
    linuxNote: 'Built into the mainline kernel as ftdi_sio — no install needed.',
  },
};

/* USB devices Windows knows about but cannot drive.
 *
 * `pnputil /enum-devices /problem` lists exactly these. Parsed rather than
 * shelling to PowerShell because pnputil is present on every Windows since 8
 * and needs no execution-policy dance. */
export function findProblemDevices() {
  if (process.platform !== 'win32') return { supported: false, devices: [] };

  let out = '';
  try {
    const r = spawnSync('pnputil', ['/enum-devices', '/problem'], {
      encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, windowsHide: true,
    });
    out = `${r.stdout || ''}`;
    if (r.error) return { supported: true, devices: [], error: r.error.message };
  } catch (e) {
    return { supported: true, devices: [], error: e.message };
  }

  // Records are blank-line separated "Key: value" blocks. Field labels are
  // localised, so match on the instance-id shape rather than the label text.
  const devices = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const idMatch = block.match(/USB\\VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})[^\s]*/);
    if (!idMatch) continue;
    const nameLine = block.split(/\r?\n/).find((l) => /:/.test(l) && !/USB\\VID/i.test(l));
    const problem = (block.match(/\b(CM_PROB_\w+|0x[0-9A-Fa-f]+)\b/) || [])[1] || null;
    devices.push({
      instanceId: idMatch[0],
      vendorId: idMatch[1].toLowerCase(),
      productId: idMatch[2].toLowerCase(),
      description: nameLine ? nameLine.split(':').slice(1).join(':').trim() : null,
      problem,
    });
  }
  return { supported: true, devices };
}

/* Driver advice for one detected board. */
export function driverStatusFor(board) {
  const key = board?.requiresDriver;
  if (!key) {
    return { needsDriver: false, note: 'This board does not need a vendor driver — it uses the built-in USB CDC class driver.' };
  }
  const pkg = DRIVER_PACKAGES[key];
  if (!pkg) return { needsDriver: false, note: `Unknown driver family "${key}".` };

  // A port that enumerated is proof the driver is working.
  if (board.port) {
    return {
      needsDriver: false,
      driver: pkg.name,
      note: `${pkg.name} is installed and working — the board enumerated as ${board.port}.`,
    };
  }
  return {
    needsDriver: true,
    driver: pkg.name,
    chips: pkg.chips,
    url: pkg.url,
    ...(process.platform === 'linux' ? { note: pkg.linuxNote } : {}),
  };
}

/* The whole picture: what is plugged in, what cannot be driven, and what the
 * user would need to do about it. */
export function diagnose(boards = []) {
  const problems = findProblemDevices();
  const findings = [];

  for (const dev of problems.devices) {
    // Match the broken device against the same id table the detector uses.
    const pkgKey = Object.keys(DRIVER_PACKAGES).find((key) => {
      if (key === 'cp210x') return dev.vendorId === '10c4';
      if (key === 'ch34x') return dev.vendorId === '1a86';
      if (key === 'ftdi') return dev.vendorId === '0403';
      return false;
    });
    const pkg = pkgKey ? DRIVER_PACKAGES[pkgKey] : null;
    findings.push({
      severity: 'blocked',
      device: dev.description || dev.instanceId,
      vendorId: dev.vendorId,
      productId: dev.productId,
      problem: dev.problem,
      diagnosis: pkg
        ? `A ${pkg.chips} USB-serial bridge is connected but has no working driver, so no COM port appears.`
        : 'A USB device is connected but Windows cannot drive it.',
      ...(pkg ? { driver: pkg.name, downloadUrl: pkg.url } : {}),
      action: pkg
        ? `Install ${pkg.name} from ${pkg.url}, then unplug and replug the board.`
        : 'Check Device Manager for the flagged device.',
    });
  }

  if (process.platform === 'linux') {
    findings.push({
      severity: 'info',
      diagnosis: 'On Linux, serial access usually needs group membership rather than a driver.',
      action: 'If a port exists but opening it is denied: sudo usermod -a -G dialout $USER, then log out and back in.',
    });
  }

  return {
    platform: process.platform,
    supported: problems.supported,
    ...(problems.error ? { queryError: problems.error } : {}),
    boardsConnected: boards.length,
    findings,
    // The honest summary: no findings and no boards means nothing is plugged
    // in, which is different from everything being fine.
    summary: findings.filter((f) => f.severity === 'blocked').length
      ? 'A connected device has no working driver.'
      : boards.length
        ? 'All connected boards enumerated successfully.'
        : 'No boards detected and no driver problems found — nothing appears to be plugged in.',
  };
}
