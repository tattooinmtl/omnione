/* Tiny wrapper around localStorage for the live project. Kept as a module
 * (not a hook) so the same read/write helpers work from anywhere.
 */

const KEY = 'gwn:current-project';

export function defaultProject() {
  return {
    title: 'untitled',
    prompt: '',
    files: {
      'index.html': starterIndexHtml(),
      'style.css': starterCss(),
      'main.js': starterJs(),
    },
  };
}

export function loadProject() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.files || typeof parsed.files !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCurrentProject(project) {
  try {
    localStorage.setItem(KEY, JSON.stringify(project));
  } catch { /* quota or private mode — ignore */ }
}

// --- starter template so a fresh project renders something in the preview ---

function starterIndexHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>OmniOne Project</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="stage">
    <h1>OmniOne</h1>
    <p>Edit the files in the editor below. The preview updates as you type.</p>
    <canvas id="scene" width="640" height="360"></canvas>
  </div>
  <script src="main.js"></script>
</body>
</html>
`;
}

function starterCss() {
  return `:root {
  --bg: #050810;
  --fg: #e6edf3;
  --blue: #2f7bff;
}
html, body {
  margin: 0;
  height: 100%;
  background: radial-gradient(ellipse at center, #0a1226 0%, #000 70%);
  color: var(--fg);
  font-family: 'Space Grotesk', system-ui, sans-serif;
}
.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 18px;
  text-align: center;
}
h1 {
  font-size: 32px;
  letter-spacing: 0.3em;
  margin: 0;
  color: var(--blue);
  text-shadow: 0 0 24px rgba(47, 123, 255, 0.5);
}
p { color: #8a96a8; max-width: 480px; }
canvas { border: 1px solid rgba(95, 168, 255, 0.25); }
`;
}

function starterJs() {
  return `// Three.js is loaded as a global from a CDN inside the index.html <head>
// when needed, so this file can stay vanilla canvas for the starter.

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
let t = 0;

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < 12; i++) {
    const x = w / 2 + Math.cos(t + i) * (60 + i * 6);
    const y = h / 2 + Math.sin(t * 1.3 + i) * (40 + i * 4);
    ctx.beginPath();
    ctx.arc(x, y, 4 + (i % 3), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(95, 168, 255, 0.85)';
    ctx.fill();
  }
  t += 0.04;
  requestAnimationFrame(draw);
}
draw();
`;
}
