import { useCallback, useEffect, useRef, useState } from 'react';
import './AccountBar.css';

/* The account section at the bottom of the left panel, like Claude's:
 * avatar, name, tier, and a cog for Settings. Clicking the name opens a
 * menu of what the account unlocks. Connecting is optional — without an
 * account OmniOne works exactly as before, and the menu still offers the
 * local stats and settings.
 */

const TIER_LABEL = { free: 'Free plan', pro: 'Pro', founder: 'Founder', team: 'Team' };

function tierLabel(user) {
  if (!user) return 'Not connected';
  if (user.role === 'admin') return `${TIER_LABEL[user.tier] || 'Free plan'} · Admin`;
  return TIER_LABEL[user.tier] || (user.tier ? user.tier[0].toUpperCase() + user.tier.slice(1) : 'Free plan');
}

function initials(name, email) {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s._@-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
}

export function Avatar({ user, size = 32 }) {
  const [broken, setBroken] = useState(false);
  if (user?.avatar && !broken) {
    return <img className="acct-avatar" src={user.avatar} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <span className={`acct-avatar acct-avatar--initials${user ? '' : ' is-guest'}`} style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      {user ? initials(user.name, user.email) : (
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" /></svg>
      )}
    </span>
  );
}

const Icon = {
  profile: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9c0-4.4 3.6-8 8-8s8 3.6 8 8" />,
  stats: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  forum: <path d="M4 5h16v10H9l-5 4V5Z" />,
  series: <path d="M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />,
  help: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.5-11.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14m0 3h.01" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />,
  out: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" />,
  doctor: <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z" />,
  connect: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
};
const Svg = ({ d }) => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">{d}</svg>;

const open = (url) => window.open(url, '_blank', 'noopener');

export default function AccountBar({ onOpenSettings, onOpenStats, onOpenDoctor, fixesPending = 0, onOpenHelp, toast }) {
  const [account, setAccount] = useState(null);
  const [menu, setMenu] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const root = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/account');
      if (r.ok) {
        const a = await r.json();
        setAccount(a);
        window.dispatchEvent(new CustomEvent('gwn:account', { detail: a }));
      }
    } catch { /* server down: keep what we have */ }
  }, []);

  useEffect(() => {
    load();
    // Pick up name, avatar or tier changes made on the website.
    fetch('/api/account/refresh', { method: 'POST' }).then((r) => (r.ok ? r.json() : null)).then((a) => a && setAccount(a)).catch(() => {});
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => { if (!root.current?.contains(e.target)) setMenu(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const connected = Boolean(account?.connected);
  const user = account?.user;
  const site = account?.site || 'https://omnione.globalwarningnetworks.com';

  const signOut = async () => {
    setMenu(false);
    const r = await fetch('/api/account/disconnect', { method: 'POST' });
    if (r.ok) {
      const a = await r.json();
      setAccount(a);
      window.dispatchEvent(new CustomEvent('gwn:account', { detail: a }));
    }
    toast?.('Signed out of your OmniOne account on this computer', 'info');
  };

  const item = (key, label, onClick, extra) => (
    <button type="button" role="menuitem" className={`acct-menu__item${extra ? ` ${extra}` : ''}`} onClick={() => { setMenu(false); onClick(); }}>
      <Svg d={Icon[key]} />{label}{['profile', 'forum', 'series'].includes(key) && <span className="acct-menu__ext" aria-hidden="true">↗</span>}
      {key === 'doctor' && fixesPending > 0 && <span className="acct-menu__badge" title={`${fixesPending} fix${fixesPending === 1 ? '' : 'es'} waiting for you`}>{fixesPending}</span>}
    </button>
  );

  return (
    <div className="acct" ref={root}>
      {menu && (
        <div className="acct-menu" role="menu" aria-label="Account">
          {connected ? (
            <div className="acct-menu__head">
              <Avatar user={user} size={36} />
              <div>
                <b>{user?.name || 'Your account'}</b>
                <span>{user?.email}</span>
              </div>
            </div>
          ) : (
            <div className="acct-menu__head acct-menu__head--guest">
              <b>Not connected</b>
              <span>Connect your account to post on the forum with Omi-One and sync your usage.</span>
            </div>
          )}
          <div className="acct-menu__group">
            {!connected && item('connect', 'Connect account…', () => setConnecting(true), 'is-primary')}
            {connected && item('profile', 'Your profile', () => open(`${site}/profile.php`))}
            {item('stats', 'Usage & stats', () => onOpenStats?.())}
            {item('doctor', 'Doctor & fixes', () => onOpenDoctor?.())}
            {item('forum', 'Forum', () => open(`${site}/forum/`))}
            {item('series', 'Omni series', () => open(`${site}/downloads.php`))}
          </div>
          <div className="acct-menu__group">
            {item('help', 'Help', () => onOpenHelp?.())}
            {item('settings', 'Settings', () => onOpenSettings?.())}
          </div>
          {connected && <div className="acct-menu__group">{item('out', 'Sign out', signOut)}</div>}
        </div>
      )}

      <button
        type="button"
        className="acct__who"
        onClick={() => setMenu((m) => !m)}
        aria-haspopup="menu"
        aria-expanded={menu}
      >
        <Avatar user={connected ? user : null} />
        <span className="acct__text">
          <b>{connected ? user?.name || 'Your account' : 'Connect account'}</b>
          <span>{tierLabel(connected ? user : null)}</span>
        </span>
      </button>
      <button type="button" className="acct__cog" onClick={() => onOpenSettings?.()} title="Settings" aria-label="Settings">
        <Svg d={Icon.settings} />
      </button>

      {connecting && (
        <ConnectDialog
          onClose={() => setConnecting(false)}
          onConnected={(a) => {
            setAccount(a);
            setConnecting(false);
            window.dispatchEvent(new CustomEvent('gwn:account', { detail: a }));
            toast?.(`Connected as ${a.user?.name || a.user?.email || 'your account'}`, 'info');
          }}
        />
      )}
    </div>
  );
}

/* The connect dialog: a short code the user approves on the website, where
 * they are already signed in. The app never asks for the password. */
function ConnectDialog({ onClose, onConnected }) {
  const [pending, setPending] = useState(null);
  const [status, setStatus] = useState('starting');
  const [error, setError] = useState('');
  const openedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer = null;
    (async () => {
      try {
        const r = await fetch('/api/account/connect', { method: 'POST' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (!alive) return;
        setPending(j.pending);
        setStatus('waiting');
        if (!openedRef.current) { openedRef.current = true; open(j.pending.verifyUrl); }
        const poll = async () => {
          try {
            const p = await fetch('/api/account/connect/poll', { method: 'POST' });
            const pj = await p.json();
            if (!alive) return;
            if (pj.status === 'approved') { onConnected(pj.account); return; }
            if (pj.status === 'denied') { setStatus('denied'); return; }
            if (pj.status === 'expired' || pj.status === 'none') { setStatus('expired'); return; }
            if (!p.ok) throw new Error(pj.error || `HTTP ${p.status}`);
          } catch (e) {
            if (!alive) return;
            setError(e.message);
          }
          timer = setTimeout(poll, 3000);
        };
        timer = setTimeout(poll, 3000);
      } catch (e) {
        if (alive) { setStatus('failed'); setError(e.message); }
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
      fetch('/api/account/connect/cancel', { method: 'POST' }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="acct-connect" role="dialog" aria-modal="true" aria-labelledby="acct-connect-title">
      <div className="acct-connect__backdrop" onClick={onClose} />
      <div className="acct-connect__panel">
        <h3 id="acct-connect-title">Connect your OmniOne account</h3>
        {status === 'starting' && <p>Asking the website for a code…</p>}
        {status === 'waiting' && pending && (
          <>
            <p>We opened <b>{pending.verifyUrl.replace(/^https?:\/\//, '').split('?')[0]}</b> in your browser. Sign in there if you need to, check that it shows this code, and click <b>Approve</b>:</p>
            <div className="acct-connect__code">{pending.userCode}</div>
            <p className="acct-connect__wait"><span className="acct-connect__spin" aria-hidden="true" />Waiting for you to approve… OmniOne never sees your password.</p>
            <div className="acct-connect__actions">
              <button type="button" onClick={() => open(pending.verifyUrl)}>Open the page again</button>
              <button type="button" className="is-ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
        {status === 'denied' && <p>You declined the connection on the website. Nothing was connected.</p>}
        {status === 'expired' && <p>That code expired before it was approved. Close this and try again.</p>}
        {status === 'failed' && <p className="acct-connect__err">Couldn’t start connecting: {error}</p>}
        {error && status === 'waiting' && <p className="acct-connect__err">{error} — still trying.</p>}
        {['denied', 'expired', 'failed'].includes(status) && (
          <div className="acct-connect__actions"><button type="button" onClick={onClose}>Close</button></div>
        )}
      </div>
    </div>
  );
}
