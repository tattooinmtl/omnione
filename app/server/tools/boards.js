// Board tools — ESP32, Arduino, RP2040 and Raspberry Pi.
//
// Compile, flash and monitor run through `bash` under the hood rather than
// spawning directly, so they inherit the permission gate, the timeout, the
// process-tree kill and the output truncation that tool already has. Writing
// a second process runner here would mean maintaining two, and the second one
// would be the one missing the abort handling.
//
// `board_list` and `board_setup` are reads: enumerating hardware and saying
// what is missing changes nothing. Compiling, flashing and writing to a
// serial port are `execute` — they run code on a device.

import fs from 'node:fs';
import path from 'node:path';
import { registerTool, executeTool } from '../toolRegistry.js';
import { detectBoards, identify } from '../boards/detect.js';
import { detectToolchains, requirementsFor, which, installCommandFor } from '../boards/toolchains.js';
import { diagnose, driverStatusFor } from '../boards/drivers.js';
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace.js';

/* Run a command through the bash tool so the whole safety apparatus applies. */
function sh(command, ctx, { cwd = '.', timeoutMs = 300_000 } = {}) {
  return executeTool('bash', { command, cwd, timeout_ms: timeoutMs }, ctx);
}

function quote(p) {
  return `"${String(p).replace(/"/g, '\\"')}"`;
}

// --- discovery -------------------------------------------------------------

registerTool({
  name: 'board_list',
  description: 'List connected microcontroller boards — serial ports with the chip identified from its USB id, plus any board sitting in a UF2 bootloader. Start here before compiling or flashing.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: async () => {
    const { serial, uf2, warnings } = await detectBoards();
    const boards = serial.map((b) => ({ ...b, driver: driverStatusFor(b) }));

    return {
      ok: true,
      result: {
        count: boards.length + uf2.length,
        boards,
        uf2Volumes: uf2,
        ...(warnings.length ? { warnings } : {}),
        ...(boards.length + uf2.length === 0
          ? { note: 'Nothing detected. If a board is plugged in, run board_doctor — on Windows a missing USB-serial driver means no port appears at all.' }
          : {}),
      },
    };
  },
});

registerTool({
  name: 'board_doctor',
  description: 'Diagnose why a board is not showing up: missing USB-serial driver, permissions, or nothing plugged in. Also reports which build tools are installed.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: async () => {
    const { serial, uf2 } = await detectBoards();
    return {
      ok: true,
      result: {
        drivers: diagnose(serial),
        toolchains: detectToolchains(),
        detected: { serial: serial.length, uf2: uf2.length },
      },
    };
  },
});

registerTool({
  name: 'board_setup',
  description: 'Report what is missing to build for a board family, and the exact commands that would install it. It does not install anything — run the commands with bash once the user has agreed.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      family: {
        type: 'string',
        enum: ['esp32', 'arduino', 'rp2040', 'samd'],
        description: 'Board family to prepare for.',
      },
    },
    required: ['family'],
  },
  handler: async ({ family }) => {
    const reqs = requirementsFor(family);
    const tools = detectToolchains();
    const missing = tools.filter((t) => !t.installed);
    return {
      ok: true,
      result: {
        ...reqs,
        installedTools: tools.filter((t) => t.installed).map((t) => `${t.id} (${t.version || 'version unknown'})`),
        missingTools: missing.map((t) => ({ id: t.id, purpose: t.purpose, installCommand: t.installCommand })),
        note: reqs.satisfied
          ? `Ready to build for ${family}.`
          : 'Run the listed commands with bash. They install SDKs and may need elevation, so explain what they do before running them.',
      },
    };
  },
});

// --- build and flash -------------------------------------------------------

registerTool({
  name: 'board_compile',
  description: 'Compile an Arduino sketch for a board. The sketch path is a folder in the workspace containing a .ino of the same name.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      sketch: { type: 'string', description: 'Sketch folder, relative to the workspace root.' },
      fqbn: { type: 'string', description: 'Fully-qualified board name, e.g. esp32:esp32:esp32dev or arduino:avr:uno.' },
    },
    required: ['sketch', 'fqbn'],
  },
  handler: async ({ sketch, fqbn }, ctx = {}) => {
    if (!which('arduino-cli')) {
      return { ok: false, error: `arduino-cli is not installed. Install it with: ${installCommandFor('arduino-cli')}` };
    }
    let abs;
    try { abs = resolveInWorkspace(sketch); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: `No such sketch folder: ${sketch}` };

    const r = await sh(
      `arduino-cli compile --fqbn ${quote(fqbn)} ${quote(abs)}`,
      ctx,
      { timeoutMs: 600_000 },
    );
    if (!r.ok) return r;

    const { exitCode, stdout, stderr } = r.result;
    return {
      ok: true,
      result: {
        sketch: toWorkspaceRelative(abs),
        fqbn,
        success: exitCode === 0,
        exitCode,
        // Compiler errors arrive on stderr; surface them as the headline
        // rather than burying them under a wall of build chatter.
        errors: exitCode === 0 ? null : parseCompileErrors(stderr || stdout),
        output: (stdout || '').slice(-4000),
        stderr: (stderr || '').slice(-4000),
      },
    };
  },
});

registerTool({
  name: 'board_upload',
  description: 'Flash a compiled sketch to a connected board over its serial port.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      sketch: { type: 'string', description: 'Sketch folder, relative to the workspace root.' },
      fqbn: { type: 'string', description: 'Fully-qualified board name.' },
      port: { type: 'string', description: 'Serial port, e.g. COM5 or /dev/ttyUSB0, as reported by board_list.' },
    },
    required: ['sketch', 'fqbn', 'port'],
  },
  handler: async ({ sketch, fqbn, port }, ctx = {}) => {
    if (!which('arduino-cli')) {
      return { ok: false, error: `arduino-cli is not installed. Install it with: ${installCommandFor('arduino-cli')}` };
    }
    let abs;
    try { abs = resolveInWorkspace(sketch); } catch (e) { return { ok: false, error: e.message }; }

    const r = await sh(
      `arduino-cli upload -p ${quote(port)} --fqbn ${quote(fqbn)} ${quote(abs)}`,
      ctx,
      { timeoutMs: 300_000 },
    );
    if (!r.ok) return r;
    const { exitCode, stdout, stderr } = r.result;
    return {
      ok: true,
      result: {
        port,
        fqbn,
        success: exitCode === 0,
        exitCode,
        output: `${stdout || ''}\n${stderr || ''}`.trim().slice(-4000),
        ...(exitCode !== 0
          ? { hint: 'If it timed out: hold BOOT (or press RESET) while the upload starts, and confirm nothing else has the port open — a serial monitor will block it.' }
          : {}),
      },
    };
  },
});

registerTool({
  name: 'board_flash_uf2',
  description: 'Flash an RP2040 board (Pico) by copying a .uf2 onto its bootloader volume. Put the board in BOOTSEL first; board_list reports the volume.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      uf2: { type: 'string', description: 'Path to the .uf2 file, relative to the workspace root.' },
      volume: { type: 'string', description: 'Bootloader volume from board_list, e.g. E:\\ or /media/user/RPI-RP2.' },
    },
    required: ['uf2', 'volume'],
  },
  handler: async ({ uf2, volume }) => {
    let abs;
    try { abs = resolveInWorkspace(uf2); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${uf2}` };
    if (!abs.toLowerCase().endsWith('.uf2')) return { ok: false, error: 'That is not a .uf2 file.' };
    if (!fs.existsSync(volume)) {
      return { ok: false, error: `Volume "${volume}" is not mounted. Hold BOOTSEL while plugging the board in, then run board_list.` };
    }
    if (!fs.existsSync(path.join(volume, 'INFO_UF2.TXT'))) {
      return { ok: false, error: `"${volume}" does not look like a UF2 bootloader volume — refusing to copy onto it.` };
    }
    try {
      fs.copyFileSync(abs, path.join(volume, path.basename(abs)));
    } catch (e) {
      // The board reboots the instant the copy completes, so the OS often
      // reports the write as failed even when it succeeded. Say so rather
      // than reporting a failure the user cannot act on.
      return {
        ok: true,
        result: {
          volume,
          file: path.basename(abs),
          copied: 'unconfirmed',
          note: `The copy reported "${e.message}". That is normal: the board reboots as soon as the file lands, which looks like a write error. Run board_list to see whether it came back as a serial device.`,
        },
      };
    }
    return {
      ok: true,
      result: { volume, file: path.basename(abs), copied: true, note: 'The board reboots automatically. Run board_list to confirm it reappeared.' },
    };
  },
});

// --- ESP32 low level -------------------------------------------------------

registerTool({
  name: 'esp_chip_info',
  description: 'Read an ESP32\'s actual chip type, MAC, flash size and crystal frequency with esptool. Use it to identify a board for certain — a USB id only identifies the serial bridge, not the chip behind it.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: { port: { type: 'string', description: 'Serial port from board_list.' } },
    required: ['port'],
  },
  handler: async ({ port }, ctx = {}) => {
    const tool = which('esptool') || which('esptool.py');
    if (!tool) return { ok: false, error: `esptool is not installed. Install it with: ${installCommandFor('esptool')}` };

    const r = await sh(`${quote(tool)} --port ${quote(port)} chip_id`, ctx, { timeoutMs: 60_000 });
    if (!r.ok) return r;
    const { exitCode, stdout, stderr } = r.result;
    const text = `${stdout || ''}\n${stderr || ''}`;
    return {
      ok: true,
      result: {
        port,
        success: exitCode === 0,
        chip: (text.match(/Detecting chip type\.*\s*(.+)/i) || [, null])[1]?.trim() || null,
        features: (text.match(/Features:\s*(.+)/i) || [, null])[1]?.trim() || null,
        mac: (text.match(/MAC:\s*([0-9a-f:]+)/i) || [, null])[1] || null,
        crystal: (text.match(/Crystal is\s*(.+)/i) || [, null])[1]?.trim() || null,
        output: text.slice(-3000),
        ...(exitCode !== 0 ? { hint: 'Hold BOOT while connecting if the chip does not respond, and close any serial monitor holding the port.' } : {}),
      },
    };
  },
});

registerTool({
  name: 'esp_erase_flash',
  description: 'Erase an ESP32\'s entire flash. Destroys the firmware and any stored data on the device — only use it when the user has asked to wipe the board or to recover one that will not flash.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: { port: { type: 'string' } },
    required: ['port'],
  },
  handler: async ({ port }, ctx = {}) => {
    const tool = which('esptool') || which('esptool.py');
    if (!tool) return { ok: false, error: `esptool is not installed. Install it with: ${installCommandFor('esptool')}` };
    const r = await sh(`${quote(tool)} --port ${quote(port)} erase_flash`, ctx, { timeoutMs: 180_000 });
    if (!r.ok) return r;
    return {
      ok: true,
      result: {
        port,
        success: r.result.exitCode === 0,
        output: `${r.result.stdout || ''}\n${r.result.stderr || ''}`.trim().slice(-2000),
      },
    };
  },
});

// --- MicroPython -----------------------------------------------------------

registerTool({
  name: 'mpy_push',
  description: 'Copy a file to a MicroPython board with mpremote. A file named main.py runs automatically on boot.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      port: { type: 'string', description: 'Serial port from board_list.' },
      file: { type: 'string', description: 'Local file, relative to the workspace root.' },
      dest: { type: 'string', description: 'Name on the board. Defaults to the local file name.' },
    },
    required: ['port', 'file'],
  },
  handler: async ({ port, file, dest }, ctx = {}) => {
    if (!which('mpremote')) {
      return { ok: false, error: `mpremote is not installed. Install it with: ${installCommandFor('mpremote')}` };
    }
    let abs;
    try { abs = resolveInWorkspace(file); } catch (e) { return { ok: false, error: e.message }; }
    if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${file}` };

    const target = dest || path.basename(abs);
    const r = await sh(
      `mpremote connect ${quote(port)} fs cp ${quote(abs)} :${quote(target)}`,
      ctx,
      { timeoutMs: 60_000 },
    );
    if (!r.ok) return r;
    return {
      ok: true,
      result: {
        port,
        file: toWorkspaceRelative(abs),
        dest: target,
        success: r.result.exitCode === 0,
        output: `${r.result.stdout || ''}\n${r.result.stderr || ''}`.trim().slice(-2000),
      },
    };
  },
});

registerTool({
  name: 'mpy_run',
  description: 'Run a Python statement on a MicroPython board and return what it printed. Good for poking at hardware interactively.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      port: { type: 'string' },
      code: { type: 'string', description: 'Python to execute on the board.' },
    },
    required: ['port', 'code'],
  },
  handler: async ({ port, code }, ctx = {}) => {
    if (!which('mpremote')) {
      return { ok: false, error: `mpremote is not installed. Install it with: ${installCommandFor('mpremote')}` };
    }
    // Single quotes would be mangled by cmd.exe; base64 keeps arbitrary
    // Python intact across both shells.
    const b64 = Buffer.from(String(code), 'utf8').toString('base64');
    const runner = `import ubinascii,sys;exec(ubinascii.a2b_base64('${b64}'))`;
    const r = await sh(`mpremote connect ${quote(port)} exec ${quote(runner)}`, ctx, { timeoutMs: 60_000 });
    if (!r.ok) return r;
    return {
      ok: true,
      result: {
        port,
        success: r.result.exitCode === 0,
        output: `${r.result.stdout || ''}\n${r.result.stderr || ''}`.trim().slice(-4000),
      },
    };
  },
});

// --- serial monitor --------------------------------------------------------

registerTool({
  name: 'board_monitor',
  description: 'Read serial output from a board for a few seconds and return the lines. Use it to see what a sketch is printing after flashing.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      port: { type: 'string' },
      baud: { type: 'integer', description: 'Baud rate.', default: 115200 },
      seconds: { type: 'integer', description: 'How long to listen.', default: 5 },
    },
    required: ['port'],
  },
  handler: async ({ port, baud = 115200, seconds = 5 }, ctx = {}) => {
    const listen = Math.min(Math.max(Number(seconds) || 5, 1), 60);
    let SerialPort;
    try {
      ({ SerialPort } = await import('serialport'));
    } catch (e) {
      return { ok: false, error: `serialport is unavailable: ${e.message}` };
    }

    return new Promise((resolve) => {
      let sp;
      let buf = '';
      let settled = false;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        // Always release the port: an open handle blocks the next upload,
        // which is the single most common way flashing mysteriously fails.
        try { sp?.close(() => {}); } catch { /* already closed */ }
        resolve(payload);
      };

      const onAbort = () => finish({ ok: false, error: 'Run cancelled.' });

      try {
        sp = new SerialPort({ path: port, baudRate: Number(baud) || 115200 });
      } catch (e) {
        return finish({ ok: false, error: `Could not open ${port}: ${e.message}` });
      }

      sp.on('error', (e) => finish({
        ok: false,
        error: `${port}: ${e.message}`,
        ...(/access denied|busy/i.test(e.message)
          ? { hint: 'Something else has the port open — close any other serial monitor.' }
          : {}),
      }));
      sp.on('data', (c) => { buf = (buf + c.toString('utf8')).slice(-64_000); });

      if (ctx.signal) {
        if (ctx.signal.aborted) return onAbort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        const lines = buf.split(/\r?\n/).filter((l) => l.length);
        finish({
          ok: true,
          result: {
            port,
            baud,
            seconds: listen,
            lineCount: lines.length,
            lines: lines.slice(-200),
            ...(lines.length === 0
              ? { note: 'Nothing received. Check the baud rate matches Serial.begin(), and press RESET — most sketches only print at startup.' }
              : {}),
          },
        });
      }, listen * 1000);
      timer.unref?.();
    });
  },
});

registerTool({
  name: 'board_send',
  description: 'Write a line to a board over serial, for a sketch that reads commands.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      port: { type: 'string' },
      data: { type: 'string', description: 'Text to send.' },
      baud: { type: 'integer', default: 115200 },
      newline: { type: 'boolean', description: 'Append a newline.', default: true },
    },
    required: ['port', 'data'],
  },
  handler: async ({ port, data, baud = 115200, newline = true }) => {
    let SerialPort;
    try {
      ({ SerialPort } = await import('serialport'));
    } catch (e) {
      return { ok: false, error: `serialport is unavailable: ${e.message}` };
    }
    return new Promise((resolve) => {
      let sp;
      try {
        sp = new SerialPort({ path: port, baudRate: Number(baud) || 115200 });
      } catch (e) {
        return resolve({ ok: false, error: `Could not open ${port}: ${e.message}` });
      }
      const payload = newline ? `${data}\n` : String(data);
      sp.on('error', (e) => resolve({ ok: false, error: `${port}: ${e.message}` }));
      sp.write(payload, (err) => {
        if (err) { try { sp.close(() => {}); } catch { /* ignore */ } return resolve({ ok: false, error: err.message }); }
        sp.drain(() => {
          try { sp.close(() => {}); } catch { /* ignore */ }
          resolve({ ok: true, result: { port, bytes: Buffer.byteLength(payload), sent: data } });
        });
      });
    });
  },
});

/* Pull the actual error lines out of a compiler log. */
function parseCompileErrors(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!/\b(error|Error):/.test(line)) continue;
    const m = line.match(/^(.*?):(\d+):(?:(\d+):)?\s*(?:fatal\s+)?error:\s*(.*)$/i);
    if (m) out.push({ file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : null, message: m[4].trim() });
    else out.push({ message: line.trim() });
    if (out.length >= 25) break;
  }
  return out.length ? out : null;
}

export { identify, parseCompileErrors };
