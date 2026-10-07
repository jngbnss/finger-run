import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { animationScaleFromPower } from "./game/powerCurve";
import { useInputPower } from "./input/useInputPower";
import { laneColor } from "./multiplayer/lanes";
import { MAX_PLAYERS, toRoomError, type ErrorCode } from "./multiplayer/protocol";
import { createRealtimeDeps } from "./multiplayer/realtimeDeps";
import { RoomSession, type SessionView } from "./multiplayer/roomSession";
import { RaceScene, type SceneRunner } from "./scene/RaceScene";
import { GameViewport } from "./ui/GameViewport";
import { formatTime } from "./ui/Hud";
import { InputPanel } from "./ui/InputPanel";
import { Lobby } from "./ui/Lobby";
import { OnlineEntry, rememberNickname } from "./ui/OnlineEntry";
import { ResultsBoard, Standings } from "./ui/Standings";
import { useReducedMotion } from "./ui/useReducedMotion";
import type { DrawingState } from "./skin/useDrawing";
import { DrawingUpload } from "./ui/DrawingUpload";

const ENTRY_ERRORS: Partial<Record<ErrorCode, string>> = {
  ROOM_NOT_FOUND: "No room with that code. Check the code or ask the host for the link.",
  ROOM_FULL: `This room already has ${MAX_PLAYERS} players.`,
  ROOM_ALREADY_RUNNING: "That room is racing right now. Try again when the race is over.",
  INVALID_NICKNAME: "Nickname must be 1 to 16 characters.",
  CONNECTION_LOST: "Could not reach the server. Check your connection and try again.",
  NOT_ALL_READY: "Everyone must be READY before starting.",
  NOT_ENOUGH_PLAYERS: "At least 2 players are needed.",
  NOT_HOST: "Only the host can start the race.",
};

function describeError(error: unknown) {
  const err = toRoomError(error);
  return { code: err.code, message: ENTRY_ERRORS[err.code] ?? err.message };
}

function setRoomInUrl(code: string | null) {
  const url = new URL(location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  history.replaceState(null, "", url);
}

export function shareUrlFor(code: string) {
  return `${location.origin}${import.meta.env.BASE_URL}?room=${code}`;
}

const LANE_WIDTH = 1.3;

interface OnlineGameProps {
  initialCode: string;
  drawing: DrawingState;
}

const SKIN_NOTES: Record<SessionView["skinStatus"], string | null> = {
  off: null,
  uploading: "Sharing your skin with the room…",
  shared: "Your skin is shared with this room only and deleted when you leave.",
  error: "Could not share your skin (storage not set up?). Others see the plain robot.",
};

export function OnlineGame({ initialCode, drawing }: OnlineGameProps) {
  const drawingUrl = drawing.url;
  const deps = useMemo(createRealtimeDeps, []);
  const input = useInputPower();
  const sourceRef = useRef(input.source);
  sourceRef.current = input.source;
  const [session, setSession] = useState<RoomSession | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reducedMotion = useReducedMotion();

  const open = useCallback(
    async (connect: () => Promise<RoomSession>, nickname: string) => {
      setBusy(true);
      setError(null);
      try {
        const s = await connect();
        rememberNickname(nickname);
        setRoomInUrl(s.getView().code);
        setSession(s);
        setView(s.getView());
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // Timers: 50ms tick (works in background tabs, unlike rAF) and rAF for rendering.
  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      session.setLocalPower(sourceRef.current.read());
      session.tick();
    }, 50);
    let frame = 0;
    let lastUi = 0;
    const render = (now: number) => {
      const v = session.getView();
      // 60fps while racing, ~5fps in the lobby and results.
      if (v.phase === "RACE" || now - lastUi > 200) {
        lastUi = now;
        setView(v);
        if (v.phase === "LEFT") {
          setSession(null);
          setRoomInUrl(null);
          if (v.notice) setError({ code: v.notice.code, message: v.notice.message });
        }
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    const unsubscribe = session.subscribe(() => setView(session.getView()));
    return () => {
      clearInterval(interval);
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [session]);

  // Leave the room when this screen unmounts (switching back to SOLO). Page reloads keep the slot.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => () => void sessionRef.current?.leave().catch(() => {}), []);

  // Share the skin while the toggle is on; stop sharing when it is turned off.
  const sharedBlob = drawing.skinOn ? (drawing.skin?.blob ?? null) : null;
  useEffect(() => {
    if (session) void session.setSkin(sharedBlob);
  }, [session, sharedBlob]);

  useEffect(() => {
    session?.setCameraReady(input.mode === "CAMERA" && input.hand.view.status === "RUNNING");
  }, [session, input.mode, input.hand.view.status]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const leave = () =>
    act(async () => {
      const s = session;
      setSession(null);
      setView(null);
      setRoomInUrl(null);
      await s?.leave();
    });

  const inputPanel = (
    <InputPanel mode={input.mode} onMode={input.setMode} hand={input.hand} slider={input.slider} onSlider={input.setSlider} />
  );
  const drawingPanel = (
    <DrawingUpload
      drawingUrl={drawingUrl}
      onDrawing={drawing.setUrl}
      skinOn={drawing.skinOn}
      onSkinOn={drawing.setSkinOn}
      skinLabel="Wear it as my skin and share it with this room"
      skinNote={view ? SKIN_NOTES[view.skinStatus] : null}
    />
  );
  const mySkinUrl = drawing.skinOn ? (drawing.skin?.url ?? null) : null;
  const skinOf = (userId: string, isMe: boolean) => (isMe ? mySkinUrl : (view?.skins[userId] ?? null));

  if (!session || !view) {
    return (
      <main>
        <GameViewport
          scene={(onContextLost) => (
            <RaceScene
              laneCount={MAX_PLAYERS}
              laneWidth={LANE_WIDTH}
              runners={[]}
              focusDistanceM={0}
              focusSpeedMps={0}
              drawingUrl={drawingUrl}
              reducedMotion={reducedMotion}
              onRunnerStatus={() => {}}
              onContextLost={onContextLost}
            />
          )}
        />
        <aside>
          <OnlineEntry
            enabled={deps !== null}
            busy={busy}
            error={error}
            initialCode={initialCode}
            onCreate={(nickname) => deps && open(() => RoomSession.create({ ...deps, now: Date.now }, nickname), nickname)}
            onJoin={(code, nickname) => deps && open(() => RoomSession.join({ ...deps, now: Date.now }, code, nickname), nickname)}
          />
          {inputPanel}
          {drawingPanel}
        </aside>
      </main>
    );
  }

  const me = view.runners.find((r) => r.isMe);
  const racing = view.phase === "RACE";
  const runners: SceneRunner[] = racing
    ? view.runners.map((r) => {
        const moving = r.status === "RUNNING" && !view.stale;
        return {
          id: r.userId,
          lane: r.lane,
          distanceM: r.distanceM,
          speedMps: r.speedMps,
          smoothedPower: r.power,
          animationScale: moving ? animationScaleFromPower(r.power) : 0,
          running: moving,
          tint: laneColor(r.lane),
          label: `${r.rank}. ${r.nickname}`,
          isLocal: r.isMe,
          skinUrl: skinOf(r.userId, r.isMe),
        };
      })
    : view.players.map((p) => ({
        id: p.userId,
        lane: p.lane,
        distanceM: 0,
        speedMps: 0,
        smoothedPower: 0,
        animationScale: 0,
        running: false,
        tint: laneColor(p.lane),
        label: p.nickname,
        isLocal: p.isMe,
        skinUrl: skinOf(p.userId, p.isMe),
      }));

  const showNotice = view.notice && !(view.stale && view.notice.code === "CONNECTION_LOST");

  return (
    <main>
      <GameViewport
        scene={(onContextLost) => (
          <RaceScene
            laneCount={MAX_PLAYERS}
            laneWidth={LANE_WIDTH}
            runners={runners}
            focusDistanceM={me?.distanceM ?? 0}
            focusSpeedMps={me && !view.stale ? me.speedMps : 0}
            drawingUrl={drawingUrl}
            reducedMotion={reducedMotion}
            onRunnerStatus={() => {}}
            onContextLost={onContextLost}
          />
        )}
      >
        {racing && view.countdownLabel && (
          <div
            key={view.countdownLabel}
            className={`overlay-label${view.countdownLabel === "GO!" ? " go" : ""}${view.countdownLabel === "GET READY" ? " small" : ""}`}
            data-testid="countdown"
            aria-hidden
          >
            {view.countdownLabel}
          </div>
        )}
        <p className="sr-only" aria-live="assertive">
          {racing ? (view.countdownLabel ?? "") : ""}
        </p>
        {view.stale && racing && (
          <div className="banner bad" role="alert" data-testid="connection-banner">
            CONNECTION_LOST: no race updates for over 1.5s. Positions are frozen until the connection recovers.
          </div>
        )}
        {showNotice && (
          <div className="banner warn" role="alert">
            <strong>{view.notice!.code}</strong> {view.notice!.message}
            <button type="button" className="link" onClick={() => session.clearNotice()}>
              Dismiss
            </button>
          </div>
        )}
        {view.phase === "RESULTS" && me && (
          <div className="result" role="status">
            {me.status === "FINISHED" && me.finishTimeMs !== null
              ? `#${me.rank} — ${formatTime(me.finishTimeMs)}`
              : `DNF — ${me.distanceM.toFixed(1)}m`}
          </div>
        )}
      </GameViewport>
      <aside>
        {racing && me && (
          <section className="card hud" aria-label="Your race">
            <div className="phase phase-running">LANE {me.lane} · #{me.rank}</div>
            <dl>
              <div>
                <dt>Power</dt>
                <dd>{Math.round(sourceRef.current.read())}</dd>
              </div>
              <div>
                <dt>Speed</dt>
                <dd>{me.speedMps.toFixed(1)} m/s</dd>
              </div>
              <div>
                <dt>Distance</dt>
                <dd>{me.distanceM.toFixed(1)} / 100 m</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>{formatTime(view.raceElapsedMs)}</dd>
              </div>
            </dl>
            <div className="progress" aria-hidden>
              <div style={{ width: `${me.distanceM}%` }} />
            </div>
          </section>
        )}
        {racing && <Standings runners={view.runners} raceId={view.raceId} startAt={view.startAt} />}
        {view.phase === "RESULTS" && view.results && (
          <ResultsBoard results={view.results} busy={busy} onRematch={() => act(() => session.rematch())} onLeave={leave} />
        )}
        {view.phase === "LOBBY" && (
          <Lobby
            view={view}
            shareUrl={shareUrlFor(view.code)}
            busy={busy}
            onReady={(ready) => act(() => session.setReady(ready))}
            onStart={() => act(() => session.start())}
            onLeave={leave}
            skinOf={skinOf}
          />
        )}
        {inputPanel}
        {view.phase !== "RACE" && drawingPanel}
        {error && (
          <div className="error-box" role="alert">
            <strong>{error.code}</strong>
            <p>{error.message}</p>
          </div>
        )}
      </aside>
    </main>
  );
}
