// The floating windows' link to OmniOne.exe.
//
// Inside OmniOne.exe each floating window is a native window, and the shell
// binds a few functions into its page (go-webview2 Bind: each returns a
// Promise): pin on top, open another floating window, open the main app.
// In a plain browser (development, or the app opened at its URL) there is no
// shell: the buttons open popups instead and "on top" is not offered.

export const WIDGETS = {
  presence: { title: 'Omi-One', width: 360, height: 480 },
  emotion: { title: 'Emotion engine', width: 760, height: 440 },
  neural: { title: 'Neural network', width: 760, height: 520 },
};

const has = (name) => typeof window !== 'undefined' && typeof window[name] === 'function';

export const native = {
  get available() { return has('omnioneWindow_open'); },

  async state() {
    if (!has('omnioneWindow_state')) return { onTop: false };
    try { return (await window.omnioneWindow_state()) || { onTop: false }; } catch { return { onTop: false }; }
  },

  async setOnTop(on) {
    if (!has('omnioneWindow_setOnTop')) return false;
    try { return Boolean(await window.omnioneWindow_setOnTop(Boolean(on))); } catch { return false; }
  },

  async open(kind) {
    if (!WIDGETS[kind]) return;
    if (has('omnioneWindow_open')) {
      try { await window.omnioneWindow_open(kind); return; } catch { /* fall through to a popup */ }
    }
    const w = WIDGETS[kind];
    window.open(`/widget/${kind}`, `omnione-${kind}`, `popup,width=${w.width},height=${w.height}`);
  },

  async openApp(hash = '') {
    if (has('omnioneWindow_openApp')) {
      try { await window.omnioneWindow_openApp(String(hash)); return; } catch { /* fall through */ }
    }
    window.open(`/app${hash ? `#${hash}` : ''}`, 'omnione-app');
  },
};
