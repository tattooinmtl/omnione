---
name: classic-arcade-game-builder
description: Build a classic arcade game (Asteroids, Pong, Snake, Breakout) with vanilla HTML/Canvas. Specs the player, the enemy loop, the score, and the game-over state.
---

# Classic Arcade Game Builder

Use this skill when the user asks for a retro arcade game.

## Default runtime
Vanilla HTML + CSS + JS in three files: `index.html`, `style.css`, `main.js`. Three.js is available via the import map in `index.html` for any 3D twist; default to 2D Canvas.

## Always include
- A clear game loop with `requestAnimationFrame` and a fixed timestep
- Score visible in the corner
- Game-over state with a "press R to restart" hint
- Keyboard controls (WASD or arrows) and a single primary action (space to shoot / jump / start)
- A muted blue/red palette consistent with the rest of GWN

## When emitting code
- Multi-file project: emit each file with a `<!-- FILE: name.ext -->` marker
- Keep total code under 400 lines per file
- No build step, no TypeScript, no npm
