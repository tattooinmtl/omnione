// Board detection.
//
// Enumerates serial ports and identifies what is on the other end from the
// USB vendor/product id, then adds mass-storage bootloaders (an RP2040 in
// BOOTSEL mode is a drive, not a serial port).
//
// Identification is by VID/PID rather than by the port's friendly name: the
// name is whatever the driver decided to call itself and varies by machine,
// locale and driver version, while the ids come from the silicon.
//
// One thing worth knowing about ESP32 boards: most use a separate USB-serial
// bridge chip (CP2102, CH340, FTDI), so the VID/PID identifies the *bridge*,
// not the ESP32 behind it. Newer S2/S3/C3 parts have native USB and report
// Espressif's own 303A. So a CP210x tells you "probably an ESP32 dev board"
// with no certainty about which one — only esptool's chip probe can settle
// that, which is why identify() reports a confidence level rather than
// pretending to know.

import fs from 'node:fs';
import path from 'node:path';

/* USB ids, lowercase hex without the 0x. */
const USB_IDS = [
  // --- USB-serial bridges: the chip, not the board behind it -------------
  { vid: '10c4', pid: 'ea60', chip: 'CP2102',  driver: 'cp210x', kind: 'bridge',
    guess: 'ESP32 dev board (CP2102 bridge)', confidence: 'low' },
  { vid: '10c4', pid: 'ea70', chip: 'CP2105',  driver: 'cp210x', kind: 'bridge',
    guess: 'ESP32 dev board (CP2105 bridge)', confidence: 'low' },
  { vid: '1a86', pid: '7523', chip: 'CH340',   driver: 'ch34x',  kind: 'bridge',
    guess: 'Arduino clone or ESP32 board (CH340 bridge)', confidence: 'low' },
  { vid: '1a86', pid: '7522', chip: 'CH340',   driver: 'ch34x',  kind: 'bridge',
    guess: 'Arduino clone or ESP32 board (CH340 bridge)', confidence: 'low' },
  { vid: '1a86', pid: '55d4', chip: 'CH9102',  driver: 'ch34x',  kind: 'bridge',
    guess: 'ESP32 board (CH9102 bridge)', confidence: 'low' },
  { vid: '1a86', pid: '5523', chip: 'CH341',   driver: 'ch34x',  kind: 'bridge',
    guess: 'Arduino clone (CH341 bridge)', confidence: 'low' },
  { vid: '0403', pid: '6001', chip: 'FT232R',  driver: 'ftdi',   kind: 'bridge',
    guess: 'FTDI serial device — Arduino or ESP32 board', confidence: 'low' },
  { vid: '0403', pid: '6015', chip: 'FT231X',  driver: 'ftdi',   kind: 'bridge',
    guess: 'FTDI serial device', confidence: 'low' },

  // --- Espressif native USB: this really is an ESP32 ---------------------
  { vid: '303a', pid: '1001', chip: 'ESP32-S2/S3', driver: null, kind: 'esp32',
    guess: 'ESP32-S2 or S3 (native USB CDC)', confidence: 'medium',
    fqbn: 'esp32:esp32:esp32s3' },
  { vid: '303a', pid: '0002', chip: 'ESP32-S2', driver: null, kind: 'esp32',
    guess: 'ESP32-S2 in download mode', confidence: 'high', fqbn: 'esp32:esp32:esp32s2' },
  { vid: '303a', pid: '1002', chip: 'ESP32-S3', driver: null, kind: 'esp32',
    guess: 'ESP32-S3 in download mode', confidence: 'high', fqbn: 'esp32:esp32:esp32s3' },
  { vid: '303a', pid: '0009', chip: 'ESP32-C3', driver: null, kind: 'esp32',
    guess: 'ESP32-C3', confidence: 'high', fqbn: 'esp32:esp32:esp32c3' },

  // --- Raspberry Pi RP2040 ----------------------------------------------
  { vid: '2e8a', pid: '0003', chip: 'RP2040', driver: null, kind: 'rp2040-bootrom',
    guess: 'Pico in BOOTSEL mode — flash by copying a .uf2', confidence: 'high' },
  { vid: '2e8a', pid: '0005', chip: 'RP2040', driver: null, kind: 'micropython',
    guess: 'Pico running MicroPython or CircuitPython', confidence: 'high' },
  { vid: '2e8a', pid: '000a', chip: 'RP2040', driver: null, kind: 'rp2040-serial',
    guess: 'Pico running a USB-serial sketch', confidence: 'high',
    fqbn: 'rp2040:rp2040:rpipico' },
  { vid: '2e8a', pid: '00c0', chip: 'RP2040', driver: null, kind: 'micropython',
    guess: 'Pico running MicroPython', confidence: 'high' },

  // --- Genuine Arduino ---------------------------------------------------
  { vid: '2341', pid: '0043', chip: 'ATmega16U2', driver: null, kind: 'arduino',
    guess: 'Arduino Uno', confidence: 'high', fqbn: 'arduino:avr:uno' },
  { vid: '2341', pid: '0001', chip: 'ATmega8U2', driver: null, kind: 'arduino',
    guess: 'Arduino Uno', confidence: 'high', fqbn: 'arduino:avr:uno' },
  { vid: '2341', pid: '0042', chip: 'ATmega16U2', driver: null, kind: 'arduino',
    guess: 'Arduino Mega 2560', confidence: 'high', fqbn: 'arduino:avr:mega' },
  { vid: '2341', pid: '8036', chip: 'ATmega32U4', driver: null, kind: 'arduino',
    guess: 'Arduino Leonardo', confidence: 'high', fqbn: 'arduino:avr:leonardo' },
  { vid: '2341', pid: '804d', chip: 'SAMD21', driver: null, kind: 'arduino',
    guess: 'Arduino Zero', confidence: 'high', fqbn: 'arduino:samd:arduino_zero_native' },
  { vid: '2a03', pid: '0043', chip: 'ATmega16U2', driver: null, kind: 'arduino',
    guess: 'Arduino Uno (arduino.org)', confidence: 'high', fqbn: 'arduino:avr:uno' },

  // --- Adafruit / SparkFun boards commonly used with CircuitPython -------
  { vid: '239a', pid: null, chip: 'Adafruit board', driver: null, kind: 'circuitpython',
    guess: 'Adafruit board (often CircuitPython)', confidence: 'medium' },
];

/* Match a port against the id table. A row with pid: null matches any product
 * from that vendor, and is only used as a fallback when nothing exact hits. */
export function identify({ vendorId, productId }) {
  const vid = String(vendorId || '').toLowerCase().replace(/^0x/, '');
  const pid = String(productId || '').toLowerCase().replace(/^0x/, '');
  if (!vid) return null;

  const exact = USB_IDS.find((r) => r.vid === vid && r.pid === pid);
  if (exact) return exact;
  const vendorOnly = USB_IDS.find((r) => r.vid === vid && r.pid === null);
  if (vendorOnly) return vendorOnly;
  return {
    vid, pid, chip: 'unknown', driver: null, kind: 'unknown',
    guess: `Unrecognised USB device ${vid}:${pid}`, confidence: 'none',
  };
}

/* Every serial port, annotated. */
export async function listSerialPorts() {
  let SerialPort;
  try {
    ({ SerialPort } = await import('serialport'));
  } catch (e) {
    // The native module failed to load — a prebuilt binary missing for this
    // Node ABI, most likely. Say so rather than reporting "no boards".
    const err = new Error(`serialport is unavailable: ${e.message}. Run "npm rebuild serialport".`);
    err.code = 'SERIALPORT_UNAVAILABLE';
    throw err;
  }

  const ports = await SerialPort.list();
  return ports.map((p) => {
    const id = identify(p);
    return {
      port: p.path,
      vendorId: (p.vendorId || '').toLowerCase(),
      productId: (p.productId || '').toLowerCase(),
      serialNumber: p.serialNumber || null,
      manufacturer: p.manufacturer || null,
      friendlyName: p.friendlyName || p.pnpId || null,
      chip: id?.chip || 'unknown',
      kind: id?.kind || 'unknown',
      guess: id?.guess || null,
      confidence: id?.confidence || 'none',
      requiresDriver: id?.driver || null,
      suggestedFqbn: id?.fqbn || null,
    };
  });
}

/* An RP2040 held in BOOTSEL appears as a mass-storage volume named RPI-RP2,
 * not as a serial port, so it is invisible to the enumeration above. Flashing
 * it is literally copying a .uf2 file onto the drive. */
export function findUf2Volumes() {
  const found = [];
  const candidates = [];

  if (process.platform === 'win32') {
    for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c += 1) {
      candidates.push(`${String.fromCharCode(c)}:\\`);
    }
  } else {
    for (const base of ['/media', '/run/media', '/Volumes']) {
      if (!fs.existsSync(base)) continue;
      try {
        for (const entry of fs.readdirSync(base)) {
          const dir = path.join(base, entry);
          candidates.push(dir);
          // Linux nests one level deeper: /media/<user>/<label>
          try {
            for (const sub of fs.readdirSync(dir)) candidates.push(path.join(dir, sub));
          } catch { /* not a directory we can read */ }
        }
      } catch { /* unreadable mount root */ }
    }
  }

  for (const vol of candidates) {
    try {
      if (!fs.existsSync(path.join(vol, 'INFO_UF2.TXT'))) continue;
      const info = fs.readFileSync(path.join(vol, 'INFO_UF2.TXT'), 'utf8');
      const model = (info.match(/^Model:\s*(.+)$/m) || [, ''])[1].trim();
      const boardId = (info.match(/^Board-ID:\s*(.+)$/m) || [, ''])[1].trim();
      found.push({
        volume: vol,
        model: model || 'UF2 bootloader',
        boardId: boardId || null,
        kind: 'uf2',
        guess: model ? `${model} in bootloader mode` : 'UF2 bootloader — copy a .uf2 here to flash',
        confidence: 'high',
      });
    } catch { /* drive not ready, or no permission */ }
  }
  return found;
}

/* Everything connected, serial and UF2 together. */
export async function detectBoards() {
  const result = { serial: [], uf2: findUf2Volumes(), warnings: [] };
  try {
    result.serial = await listSerialPorts();
  } catch (e) {
    result.warnings.push(e.message);
  }
  return result;
}

export { USB_IDS };
