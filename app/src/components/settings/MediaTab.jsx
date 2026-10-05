import { usePrefs, Msg, Section, Switch } from './shared.jsx';

const RATIOS = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'];
const MUSIC = [
  ['music-3.0', 'Music 3.0 (best)'],
  ['music-2.6', 'Music 2.6'],
  ['music-3.0-free', 'Music 3.0 free (slow, 3 per minute)'],
];

/* Settings → Media: defaults for pictures, music and video. */
export default function MediaTab() {
  const { prefs, save, msg } = usePrefs();
  if (!prefs) return <Msg msg={msg} />;
  const m = prefs.media;

  return (
    <>
      <Section title="What Omi-One can make" lead="All of these use your MiniMax key and cost credits per item, so Omi-One asks before each one. Ask in the chat: “draw a logo for…”, “make a 30-second song about…”, “make a 6-second video of…”.">
        <ul className="settings-modal__rules">
          <li className="is-yes"><b>Pictures</b>: from a description, up to 4 at a time. Give it a photo of a person to keep their face.</li>
          <li className="is-yes"><b>Picture edits</b> (“remove the background”, “make it night”): need an OpenAI key, added in the AI tab.</li>
          <li className="is-yes"><b>Songs and instrumentals</b>: with your lyrics, or Omi-One writes them.</li>
          <li className="is-yes"><b>Video</b>: 4 to 15 seconds, up to 2K.</li>
          <li className="is-yes"><b>Narration</b>: any text read aloud, in any voice including cloned ones.</li>
        </ul>
      </Section>

      <Section title="Defaults">
        <div className="settings-form">
          <div className="settings-form__row">
            <label>
              <span>Picture shape</span>
              <select id="media-ratio" value={m.imageRatio} onChange={(e) => save({ media: { imageRatio: e.target.value } })}>
                {RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label>
              <span>Music model</span>
              <select id="media-music" value={m.musicModel} onChange={(e) => save({ media: { musicModel: e.target.value } })}>
                {MUSIC.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
          </div>
        </div>
        <Switch
          id="media-optimizer"
          on={m.imagePromptOptimizer}
          onChange={(on) => save({ media: { imagePromptOptimizer: on } })}
          label="Let MiniMax improve picture prompts"
          hint="Adds detail to short descriptions. Turn off when you want exactly what you wrote."
        />
        <Msg msg={msg} />
      </Section>
    </>
  );
}
