# FINGER RUN 3D: Power Control Prototype

A frontend-only 100m time-trial that proves one loop:

`power 0..100 -> runner movement speed -> run animation playback speed`

- Live demo: https://jngbnss.github.io/finger-run/
- GitHub: https://github.com/jngbnss/finger-run
- Local checkout: `C:\demo\finger-run`

## Prerequisites

- Node.js 20.19+ or 22.12+ (CI uses Node 24)
- npm (the repo uses `package-lock.json`)
- A browser with WebGL

## Commands

```bash
npm install          # install
npm run dev          # dev server: http://localhost:5173/finger-run/
npm test -- --run    # unit tests (Vitest, pure game logic)
npm run build        # type-check + production build into dist/
npm run preview      # serve dist/ at http://localhost:4173/finger-run/
```

## Controls

| Control | What it does |
|---|---|
| POWER slider (0 to 100) | Target power. Below 5 is a dead zone (no movement). |
| START | Only from READY. Counts down 3, 2, 1, then GO! |
| RESET | Back to READY from any phase. Keeps the slider value and best run. |
| Clear best | Deletes the saved best run and its ghost. |
| Upload drawing | PNG/JPG up to 5MB, shown as a flat image on the finish banner. |

The race ends at 100m (FINISHED) or after 60 simulated seconds (DNF). A DNF is never saved.
Your best finished run is saved in `localStorage` (`finger-run.best.v1`) and replays as a translucent cyan ghost in the next lane.

The uploaded drawing is **not** converted to 3D. It stays in the browser tab and is never uploaded or saved.

## How it works

- `src/game/` holds deterministic race math in plain TypeScript with no React or three.js: power smoothing, speed and animation curves, the phase machine (`IDLE -> COUNTDOWN -> RUNNING -> FINISHED | DNF`), exact finish and timeout handling, ghost recording, validation and interpolation. All unit tests target this folder.
- `App.tsx` runs the simulation loop with `requestAnimationFrame`, outside the WebGL canvas. Frame time is clamped to 50ms, so time in a hidden tab pauses the race.
- `src/scene/` renders engine snapshots with `@react-three/fiber`. Renderers pass the engine's `animationScale` straight through and never repeat power math.
- `src/ui/` holds the HUD, the controls, and the drawing upload. They stay mounted even if WebGL fails.

### GLB runner and fallback

1. `AnimatedRunner` loads `public/models/RobotExpressive.glb` with `useGLTF`, inside `Suspense` and an error boundary.
2. It picks the `Running` clip (then `Run`, then `Walking`, case-insensitive), clones it, and pins root/hips/pelvis x and z position keys to their first value. The runner keeps its vertical bounce but has no root motion. World position belongs only to the outer group, driven by `distanceM`.
3. While loading, the procedural runner is shown with a "Loading runner model…" note.
4. If the file is missing, fails to parse, or has no usable clip, the error boundary renders `ProceduralRunner`: a stick robot built from primitives with sinusoidal limb swing driven by the same `animationScale`. A small warning names the reason.

The game is fully playable with no GLB and no network.

### Error handling

WebGL is checked before mounting the canvas. Scene render errors are caught by an error boundary. A lost WebGL context (`webglcontextlost`) unmounts the scene and shows a panel with a retry button. In all three cases the HUD and controls keep working. Corrupt saved ghost data is ignored, with a notice. Bad upload type, size, or bytes show an error and keep the previous drawing.

## GitHub Pages deployment

- `vite.config.ts` sets `base: "/finger-run/"`, so every built asset URL starts with `/finger-run/`.
- `.github/workflows/pages.yml` runs on push to `main`: `npm ci`, tests, build, a check that `dist/index.html` uses the `/finger-run/` base, then uploads `dist/` and deploys it with `actions/deploy-pages`. Pull requests build and test but do not deploy.
- One-time setting: **Settings → Pages → Build and deployment → Source = GitHub Actions**. With the old "Deploy from a branch" setting, Pages would serve the unbuilt source `index.html`.

## Current limitations

- Power comes from a slider only. There is no camera or hand input yet.
- Single player. The ghost is the only opponent.
- The ghost always uses the same model as the player and is shown even before the race starts.
- At power 0 the GLB runner holds a frozen mid-stride pose instead of an idle animation.
- The drawing is a flat texture on the banner. It is not persisted and not applied to the runner.
- About 340KB gzipped JS (mostly three.js) in a single chunk.

## Next phases (documentation only, not started)

1. **MediaPipe**: drive power from finger or hand motion captured by the webcam.
2. **WebSocket multiplayer**: live races between several players, with a small server relaying power and position.
3. **TripoSR**: turn the uploaded 2D drawing into a 3D mesh.
4. **UniRig**: automatically rig that mesh so it can play the running animation in place of the robot.

None of these dependencies are installed and none of their code is scaffolded in this repository.

## Assets

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The runner is `RobotExpressive.glb` from the three.js examples, licensed CC0.
