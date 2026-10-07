# FINGER RUN 3D: Power Control Prototype

A 100m sprint where **your index finger is the throttle**:

`finger speed (camera) or slider 0..100 -> runner speed -> run animation speed`

Play alone against your best ghost (SOLO) or race 2 to 7 friends live in a room (ONLINE).

- Live demo: https://jngbnss.github.io/finger-run/
- GitHub: https://github.com/jngbnss/finger-run
- Local checkout: `C:\demo\finger-run`

## Prerequisites

- Node.js 20.19+ or 22.12+ (CI uses Node 24)
- npm (the repo uses `package-lock.json`)
- A browser with WebGL. For the camera: HTTPS or `localhost`, and a front camera or webcam.
- For ONLINE: a free Supabase project (see below). SOLO needs nothing else.

## Commands

```bash
npm install                    # install
cp .env.example .env.local     # optional: Supabase values for ONLINE
npm run dev                    # http://localhost:5173/finger-run/
npm test -- --run              # unit + integration + SQL migration tests (Vitest)
npm run build                  # type-check + production build into dist/
npx playwright install chromium  # once, for browser tests
npx playwright test            # browser E2E (builds, serves on :4173, fake camera + fake realtime)
npm run preview                # serve dist/ at http://localhost:4173/finger-run/
```

The E2E test "ONLINE without Supabase settings" expects a build without `.env.local`; move that file aside when running Playwright locally.

## How to play

1. Pick **SOLO** or **ONLINE** on the first screen.
2. Input is **CAMERA** by default. Press **ENABLE CAMERA** (the camera is never opened before you click).
3. First time only: a 2 second **CALIBRATE**. Hold your hand still for 1 second, then wiggle your index finger as fast as you can for 1 second. **RECALIBRATE** repeats it.
4. Move your index finger fast to run fast. Stop moving and the runner slows down.
5. No camera, or permission denied? Press **USE SLIDER** (or the SLIDER toggle) and drag the power slider. Arrow keys / Home / End work on the slider.

| Control | What it does |
|---|---|
| CAMERA / SLIDER | Choose the power input. Switching to SLIDER releases the camera. |
| START / RESET (SOLO) | Start the 3, 2, 1, GO! countdown; reset keeps the best run. |
| Clear best (SOLO) | Deletes the saved best run and its ghost. |
| CREATE ROOM / JOIN ROOM | ONLINE: make a room (you are the host) or enter a 6-character code. |
| COPY LINK | Copies `https://jngbnss.github.io/finger-run/?room=ABC123` for friends. |
| READY | Every player, host included, presses READY. |
| START RACE | Host only, enabled when 2 to 7 players are all READY. |
| REMATCH / LEAVE ROOM | After the race: back to the lobby already READY, or leave. |
| Upload drawing (SOLO) | PNG/JPG up to 5MB, shown as a flat image on the finish banner. Never uploaded. |

A race ends at 100m (FINISHED) or after 60 seconds (DNF). DNF runs are never saved.

### Skins (your drawing on your runner)

Upload a PNG/JPG in **Drawing & skin**. It is cropped to a 256px square and shown as a patch on your robot's chest and back (it moves with the run animation), plus on the finish banner. 3D conversion is not connected.

- **SOLO:** the skin stays on your device.
- **ONLINE:** with "Wear it as my skin and share it with this room" on (default), the 256px PNG is uploaded to the private Supabase Storage bucket `skins` at `{room_id}/{user_id}.png`. Only members of that room can read it, only you can write or delete it, and the app deletes it when you leave or untick the box. Presence carries only a version token; images never travel over Realtime. The lobby shows each player's skin as a thumbnail.
- Setup: run `supabase/migrations/20261007010000_finger_run_skins.sql` in the SQL Editor (after the rooms migration). Without it, racing still works and the UI says the skin could not be shared.
- Files from players who closed the tab without leaving stay in Storage until removed (each at most 256 KB).

### Camera privacy

Video frames and hand landmarks never leave the browser. Only the MediaPipe runtime (jsDelivr) and the hand model (Google storage) are downloaded. Online messages carry only power numbers, distances, and times.

## Camera input

`src/input/hand/`:

- MediaPipe **Hand Landmarker** (`@mediapipe/tasks-vision`), `VIDEO` mode, `numHands: 1`, GPU delegate with CPU fallback.
- Inference runs in a **module Worker** fed with transferable `ImageBitmap`s (up to 30fps). If workers or `OffscreenCanvas` are unavailable, or the worker fails to start, it runs on the main thread at 15fps.
- Uses landmarks 8 (index tip), 0 (wrist), 9 (middle MCP): `relativeTip = tip - wrist`, `palmScale = max(|wrist - middleMcp|, 0.02)`, `speed = |Δ relativeTip| / palmScale / dt` in palm lengths per second. Moving the whole hand or the camera cancels out; hand size and distance are normalized.
- Samples with `dt < 1/120s` or `dt > 0.2s` are dropped. The median of the last 150ms is smoothed with an EMA (`alpha = 0.25`), then mapped monotonically to 0..100 above a dead zone.
- Hand lost for 300ms: power fades to 0 over 500ms. On re-detection the previous position is reset, so power cannot spike.
- Calibration sets the dead zone from resting noise and the top speed from the wiggle. Implausible ranges fall back to safe defaults. The result is stored in `localStorage`.
- Leaving the screen, switching to SLIDER, or hiding the page stops every camera track and the inference loop. Press the camera button again to restart.
- Errors are reported separately: `CAMERA_PERMISSION_DENIED`, `CAMERA_NOT_FOUND`, `CAMERA_STREAM_ENDED`, `CAMERA_INSECURE_CONTEXT`, `HAND_MODEL_LOAD_FAILED`, and the `HAND_NOT_VISIBLE` hint.

## Online multiplayer (2 to 7 players)

### Architecture

- **Supabase Postgres** stores rooms and players. All writes go through RPCs (`supabase/migrations/`).
- **Realtime Presence** on `room:{roomId}` tracks who is connected, READY and camera-ready. It is updated only on join, leave and state changes.
- **Realtime Broadcast** carries the fast data on private channels:
  - `room:{roomId}:input:{userId}`: each player's `{ raceId, userId, seq, power, sentAt }`, at most 4Hz. Only the host listens.
  - `room:{roomId}:snapshot`: the host's `{ raceId, seq, serverNow, phase, startAt, players[] }`, at most 5Hz.
- **Host authority**: the host's browser runs the same pure `raceEngine` for every player (`src/multiplayer/multiRace.ts`). Clients send only power. Distances, speeds and finish times from clients are never trusted.
- **Clients** buffer snapshots and render 250ms behind, interpolating between them at 60fps without extrapolating. Duplicate or out-of-order sequences are ignored. If no snapshot arrives for 1.5s, positions freeze and a `CONNECTION_LOST` banner appears.
- **Input timeout**: no input from a player for 1.5s drops their power to 0 (the engine's smoothing decays the speed).
- **Clock sync**: `server_now()` is sampled 5 times; the lowest round trip gives the offset (midpoint method). `start_room_race()` sets `start_at = now() + 5s` and a new `race_id` in one transaction, so every device counts 3, 2, 1, GO from the same server time.
- **Message budget** for a full room: 6 clients × 4 inputs/s plus 5 snapshots/s delivered to 6 clients is about 83 messages/s, under the Supabase Free limit of 100/s.

### Disconnect policy

| Situation | Behaviour |
|---|---|
| Player drops in the lobby | Slot kept for 10s (same anonymous user rejoins the same lane), then freed. |
| Player drops mid-race | Their power decays to 0. Returning within the race resumes from the latest snapshot. |
| Host leaves the lobby | Host moves to the earliest-joined remaining player. |
| Host drops mid-race | Positions freeze; after 5s without a host heartbeat the server cancels the race (`HOST_DISCONNECTED`) and everyone returns to the lobby. Nothing is recorded. |
| 8th player tries to join | `ROOM_FULL`, decided in the database under a row lock. |
| Join during a race | `ROOM_ALREADY_RUNNING` (existing members may rejoin). |
| Different app versions | `VERSION_MISMATCH` notice; everyone should reload. |
| No Supabase settings | ONLINE shows `REALTIME_CONFIG_MISSING`; SOLO works normally. |

### Room cleanup

The heartbeat runs every 2s. A lobby or finished room with no heartbeat for 10 minutes, or a stuck race older than 30 minutes, is deleted the next time anyone creates or joins a room. Details are in the migration's header comment.

### Supabase setup

1. Create a project at https://supabase.com (Free plan is enough).
2. **Authentication → Sign In / Providers → Allow anonymous sign-ins**: enable.
3. Apply the migrations in order. Either paste `supabase/migrations/20261007000000_finger_run_rooms.sql` and then `20261007010000_finger_run_skins.sql` into **SQL Editor** and run each, or use the CLI: `supabase link --project-ref <ref>` then `supabase db push`. Both files are safe to run again.
4. **Realtime → Settings**: turn off "Allow public access" so only the private, policy-checked channels are used (recommended).
5. **Project Settings → API**: copy the Project URL and the **publishable (anon) key**. Never use the `service_role` / secret key in this app.
6. Local: put them in `.env.local` (see `.env.example`), then `npm run dev`.
7. GitHub Pages: in the repo, **Settings → Secrets and variables → Actions**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (as Variables or Secrets). The next push to `main` builds with them.

## Code map

| Path | Responsibility |
|---|---|
| `src/game/` | Solo race engine, power curve, ghost record/replay (pure TS) |
| `src/input/` | `PowerSource` (camera or slider); `hand/` camera lifecycle, Worker, landmarks to power, calibration |
| `src/multiplayer/` | Protocol and types, clock sync, lanes, multi-race coordinator, snapshot buffer, `RoomSession` controller, Supabase and in-memory fake adapters |
| `src/scene/` | three.js scene: up to 7 lanes, lane colours, name tags, local-player ring, GLB runner with procedural fallback |
| `src/ui/` | Mode select, camera panel, input toggle, lobby, standings, results, HUD, upload |
| `supabase/migrations/` | Schema, RPCs, RLS and Realtime policies; `supabase/migrations.test.ts` runs it in PGlite |
| `e2e/` | Playwright: 7 browser contexts sharing a fake Supabase, injected through `window.__FINGER_RUN_TEST__` before load (no URL switch) |

## Tests

- `npm test -- --run`: the original 43 solo tests, plus camera signal math, calibration, clock offset, lanes, ranking and tie handling, sequence and timeout rules, snapshot interpolation, a 7-player fake-transport integration suite (full race, 8th rejected, disconnect/reconnect, host migration, host-drop cancellation, 60s DNF, rematch, missed final snapshot), and the SQL migration run in PGlite (lanes, `ROOM_FULL`, RLS, RPC-only writes, host checks, pruning, Realtime topic policies).
- `npx playwright test`: 7 contexts (desktop 1280×720, 390×844 and 360×740 phones) create, join by link, enable the synthetic camera, READY, share one race id and start time, finish, and show the same leaderboard; an 8th context gets `ROOM_FULL`; camera denial falls back to the slider; no camera shows `CAMERA_NOT_FOUND`; ONLINE without settings is disabled while SOLO works.

## GitHub Pages deployment

- `vite.config.ts` sets `base: "/finger-run/"`.
- `.github/workflows/pages.yml` on push to `main`: `npm ci`, unit tests, build (with the two Supabase values from Actions variables or secrets), base-path check, deploy `dist/`. A separate `e2e` job runs Playwright without blocking the deploy.
- Pages source must be **GitHub Actions** (Settings → Pages).

## GLB runner and fallback

`AnimatedRunner` loads `public/models/RobotExpressive.glb` inside `Suspense` and an error boundary, picks the `Running` clip (then `Run`, then `Walking`), removes horizontal root motion, and tints the body to the lane colour. If the model is missing or has no usable clip, the boundary renders `ProceduralRunner`, a primitive stick robot driven by the same `animationScale`, and shows a warning. Everything is playable without the GLB.

## Current limitations

- Finger-speed tuning was checked with a synthetic hand in tests; feel on real phones still needs tuning with players.
- The host's browser is the race authority: a host on a slow phone slows snapshots for everyone, and a host tab in the background can trigger `HOST_DISCONNECTED`.
- The uploaded drawing is a flat banner texture in SOLO and on your own screen only; it is never shared or converted to 3D.

## Next phases (documentation only)

1. **TripoSR**: turn the uploaded 2D drawing into a 3D mesh.
2. **UniRig**: rig that mesh so it can play the running animation in place of the robot.

## Assets

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Runner: `RobotExpressive.glb` from the three.js examples (CC0). MediaPipe Tasks and the hand landmarker model are Apache 2.0 (loaded from CDN at runtime).
