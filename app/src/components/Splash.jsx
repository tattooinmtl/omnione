import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import NeuralBackdrop from '../three/NeuralBackdrop.jsx';
import { version } from '../../package.json';
import './Splash.css';

// OmniOne's intro, the same one the website shows (a 720p copy).
const VIDEO_SRC = '/videos/omnione-intro.mp4';

export default function Splash() {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const [muted, setMuted] = useState(true);
  const [transitioning, setTransitioning] = useState(false);

  // Keep <video> muted state in sync with the toggle button.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  const enter = () => {
    if (transitioning) return;
    setTransitioning(true);
    // Quick fade, then route to the main app shell.
    setTimeout(() => navigate('/app'), 650);
  };

  return (
    <div className={`splash ${transitioning ? 'splash--exit' : ''}`}>
      {/* Three.js neural backdrop */}
      <div className="splash__backdrop">
        <NeuralBackdrop />
      </div>

      {/* Video grain + scanline overlays */}
      <div className="grain-overlay" />
      <div className="scanlines-overlay" />

      {/* Top-right audio toggle */}
      <button
        type="button"
        className="splash__mute"
        onClick={() => setMuted((m) => !m)}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor" />
            <path d="M16 8l6 8M22 8l-6 8" stroke="currentColor" strokeWidth="2" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor" />
            <path
              d="M16 8c1.5 1.2 2.5 2.8 2.5 4s-1 2.8-2.5 4M19 5c2.8 2 4.5 4.4 4.5 7s-1.7 5-4.5 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        )}
      </button>

      {/* Hero content */}
      <div className="splash__content">
        <h1 className="splash__title" data-text="OmniOne">
          OmniOne
        </h1>
        <p className="splash__subtitle">AGENT-HARNESS &middot; BUILD &middot; ITERATE &middot; SHIP</p>

        <div className="splash__video-card">
          <video
            ref={videoRef}
            className="splash__video"
            src={VIDEO_SRC}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
          />
          <div className="splash__video-frame" aria-hidden="true" />
        </div>

        <button type="button" className="splash__enter" onClick={enter}>
          <span>ENTER</span>
        </button>

        <p className="splash__hint">click anywhere to skip &middot; press ENTER</p>
      </div>

      {/* Click-anywhere backdrop handler sits at the very top so buttons still work */}
      <button
        type="button"
        className="splash__clicklayer"
        onClick={enter}
        aria-label="Enter"
        tabIndex={-1}
      />

      <div className="splash__footer">
        <span>v{version}</span>
        <span>HOME OF OMI-ONE</span>
      </div>
    </div>
  );
}
