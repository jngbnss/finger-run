# Third-Party Notices

## RobotExpressive.glb

- File: `public/models/RobotExpressive.glb`
- Source: https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb
  (three.js repository, `examples/models/gltf/RobotExpressive/`)
- Author: Tomás Laulhé (Quaternius), with modifications by Don McCurdy, as credited in the three.js examples.
- License: CC0 1.0 Universal (public domain dedication), https://creativecommons.org/publicdomain/zero/1.0/
- Used as-is. At runtime the `Running` clip is cloned and its root/hips horizontal motion is removed.

## MediaPipe Tasks Vision and hand landmarker model

- `@mediapipe/tasks-vision` (npm) and its WebAssembly runtime, loaded at runtime from
  https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm
- Hand landmarker model, loaded at runtime from
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- License: Apache License 2.0 (Google). Not redistributed in this repository.

## npm dependencies

React, React DOM, three.js, @react-three/fiber, @react-three/drei, Vite, Vitest and @supabase/supabase-js are MIT licensed.
@playwright/test and @electric-sql/pglite are Apache 2.0 (dev only).
See each package's `LICENSE` file under `node_modules/` after `npm install`.
