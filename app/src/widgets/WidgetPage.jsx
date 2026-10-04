import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import PresenceWidget from './PresenceWidget.jsx';
import EmotionWidget from './EmotionWidget.jsx';
import NeuralWidget from './NeuralWidget.jsx';
import { native, WIDGETS } from './native.js';
import { makeOrigin, startLiveFeed } from './liveFeed.js';
import '../components/PresenceView.css';
import './Widget.css';

/* /widget/presence, /widget/emotion, /widget/neural: OmniOne's floating
 * windows. Each hears every run through the live feed; the bar on top pins
 * the window above other apps (in OmniOne.exe) and opens the others. */

const BODY = { presence: PresenceWidget, emotion: EmotionWidget, neural: NeuralWidget };

export default function WidgetPage() {
  const { kind } = useParams();
  const Body = BODY[kind];
  const origin = useMemo(() => makeOrigin(kind || 'widget'), [kind]);
  const [onTop, setOnTop] = useState(false);
  const [hasNative, setHasNative] = useState(native.available);

  useEffect(() => {
    document.title = WIDGETS[kind]?.title || 'OmniOne';
    document.body.classList.add('is-widget');
    // The shell's bindings are injected as the page loads; look once more.
    const t = setTimeout(() => setHasNative(native.available), 300);
    native.state().then((s) => setOnTop(Boolean(s?.onTop)));
    return () => { clearTimeout(t); document.body.classList.remove('is-widget'); };
  }, [kind]);

  useEffect(() => startLiveFeed({ origin, mind: true }), [origin]);

  if (!Body) {
    return <div className="widget widget--missing">No such window. <a href="/app">Open OmniOne</a></div>;
  }

  const pin = async () => {
    const next = !onTop;
    if (await native.setOnTop(next)) setOnTop(next);
  };

  return (
    <div className={`widget widget--${kind}`}>
      <header className="widget__bar">
        <span className="widget__title">{kind === 'presence' ? 'OMI-ONE' : WIDGETS[kind].title.toUpperCase()}</span>
        <span className="widget__spacer" />
        {kind !== 'presence' && <button type="button" onClick={() => native.open('presence')} title="Omi-One (Presence widget)">◉</button>}
        {kind !== 'emotion' && <button type="button" onClick={() => native.open('emotion')} title="Open the emotion engine in its own window">Emotion</button>}
        {kind !== 'neural' && <button type="button" onClick={() => native.open('neural')} title="Open the neural network in its own window">Neural</button>}
        <button type="button" onClick={() => native.openApp('')} title="Open the main OmniOne window">App</button>
        {hasNative && (
          <button type="button" className={`widget__pin ${onTop ? 'is-on' : ''}`} onClick={pin} aria-pressed={onTop} title={onTop ? 'On top of other apps: click to release' : 'Keep on top of other apps'}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 4H6l4-4-1-6ZM12 13v8" /></svg>
          </button>
        )}
      </header>
      <main className="widget__body">
        <Body origin={origin} />
      </main>
    </div>
  );
}
