import { useEffect, useRef, useState } from "preact/hooks";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { extractPoseSet, type PoseSet } from "../poseSet";
import type { ChannelDto } from "../../shared/dto";
import { formatTimestamp } from "../../shared/time";
import type { RpcClient } from "../rpcClient";
import { RpcError } from "../rpcClient";

const MAX_FRAMES = 5000;
const PAGE_COUNT = 500;
const PAGE_BYTES = 4_000_000;
const PLAYBACK_MS = 50; // ~20 fps stepping through frames

type Status = "loading" | "empty" | "ready" | "error";
interface Frame {
  logTime: string;
  poseSet: PoseSet;
}

/**
 * Generic 3D point / coordinate-frame view for any "named poses" channel (see
 * shared/pose.ts). Loads every frame, renders each pose as a point (plus an
 * optional orientation triad) with three.js, and plays through them. It draws
 * no skeleton bones — connectivity is domain-specific and out of scope.
 */
export function ScenePanel({
  channel,
  rpc,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showAxes, setShowAxes] = useState(false);
  const [zUp, setZUp] = useState(true);
  const [capped, setCapped] = useState(false);

  const framesRef = useRef<Frame[]>([]);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const frameIndexRef = useRef(0);

  // ---- Load all frames for the channel -------------------------------------
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(undefined);
    setFrameIndex(0);
    frameIndexRef.current = 0;
    setPlaying(false);
    void (async () => {
      const frames: Frame[] = [];
      let cursor: string | undefined;
      try {
        for (;;) {
          const body = await rpc.request({
            op: "queryMessages",
            topics: [channel.topic],
            cursor,
            limitCount: PAGE_COUNT,
            limitBytes: PAGE_BYTES,
          });
          if (cancelled || body.type !== "messages") {
            return;
          }
          for (const msg of body.page.messages) {
            const poseSet = extractPoseSet(channel.schemaName, msg.value);
            if (poseSet) {
              frames.push({ logTime: msg.logTime, poseSet });
            }
            if (frames.length >= MAX_FRAMES) {
              break;
            }
          }
          cursor = body.page.nextCursor;
          if (frames.length >= MAX_FRAMES) {
            setCapped(true);
            break;
          }
          if (body.page.reachedEnd || !cursor) {
            break;
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
        return;
      }
      if (cancelled) {
        return;
      }
      framesRef.current = frames;
      setStatus(frames.length > 0 ? "ready" : "empty");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  // ---- Build the three.js scene once frames are ready ----------------------
  useEffect(() => {
    if (status !== "ready" || !hostRef.current) {
      return;
    }
    const handle = createScene(hostRef.current, framesRef.current);
    sceneRef.current = handle;
    handle.showFrame(frameIndexRef.current, { showAxes, zUp });
    return () => {
      handle.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ---- Push view-state changes into the scene ------------------------------
  useEffect(() => {
    frameIndexRef.current = frameIndex;
    sceneRef.current?.showFrame(frameIndex, { showAxes, zUp });
  }, [frameIndex, showAxes, zUp]);

  // ---- Playback timer ------------------------------------------------------
  useEffect(() => {
    if (!playing || status !== "ready") {
      return;
    }
    const total = framesRef.current.length;
    const id = setInterval(() => {
      setFrameIndex((i) => (i + 1) % Math.max(1, total));
    }, PLAYBACK_MS);
    return () => clearInterval(id);
  }, [playing, status]);

  const total = framesRef.current.length;
  const current = framesRef.current[frameIndex];

  return (
    <>
      {status === "empty" && (
        <div class="dim detail-placeholder">
          No renderable poses found in this channel ({channel.schemaName}).
        </div>
      )}
      {error && <div class="error-inline">{error}</div>}

      {status === "ready" && (
        <div class="scene3d-toolbar">
          <button onClick={() => setPlaying((p) => !p)}>{playing ? "⏸ Pause" : "▶ Play"}</button>
          <button onClick={() => setFrameIndex((i) => Math.max(0, i - 1))} disabled={playing}>
            ◀
          </button>
          <button
            onClick={() => setFrameIndex((i) => Math.min(total - 1, i + 1))}
            disabled={playing}
          >
            ▶
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={frameIndex}
            onInput={(e) => {
              setPlaying(false);
              setFrameIndex(Number((e.currentTarget as HTMLInputElement).value));
            }}
            class="scene3d-scrubber"
          />
          <span class="dim mono">
            {frameIndex + 1}/{total}
            {current ? ` · ${current.poseSet.poses.length} pts · ${formatTimestamp(current.logTime)}` : ""}
            {capped ? ` · first ${MAX_FRAMES}` : ""}
          </span>
          <label class="scene3d-opt">
            <input type="checkbox" checked={showAxes} onChange={() => setShowAxes((v) => !v)} /> axes
          </label>
          <label class="scene3d-opt">
            <input type="checkbox" checked={zUp} onChange={() => setZUp((v) => !v)} /> Z-up
          </label>
          <span class="dim scene3d-hint">drag to orbit · scroll to zoom</span>
        </div>
      )}

      <div ref={hostRef} class="scene3d-host" />
    </>
  );
}

/** Full-screen page wrapper: header with Back + the ScenePanel. */
export function Scene3DView({
  channel,
  rpc,
  onBack,
}: {
  channel: ChannelDto;
  rpc: RpcClient;
  onBack: () => void;
}) {
  return (
    <main class="scene3d-view">
      <div class="browser-header">
        <button onClick={onBack}>← Back to messages</button>
        <span class="mono browser-topic">{channel.topic}</span>
        <span class="dim">{channel.schemaName}</span>
      </div>
      <ScenePanel channel={channel} rpc={rpc} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// three.js scene management (imperative; lives outside preact's render cycle)
// ---------------------------------------------------------------------------

interface SceneHandle {
  showFrame(index: number, opts: { showAxes: boolean; zUp: boolean }): void;
  dispose(): void;
}

function createScene(host: HTMLElement, frames: Frame[]): SceneHandle {
  const cs = getComputedStyle(document.body);
  const bg = new THREE.Color(cs.getPropertyValue("--vscode-editor-background").trim() || "#1e1e1e");
  const activeColor = new THREE.Color(cs.getPropertyValue("--vscode-charts-blue").trim() || "#3794ff");
  const inactiveColor = new THREE.Color(cs.getPropertyValue("--vscode-descriptionForeground").trim() || "#888888");

  const scene = new THREE.Scene();
  scene.background = bg;

  const { center, radius } = boundsOf(frames);
  const pointRadius = Math.max(0.004, radius * 0.02);
  const axisSize = Math.max(0.02, radius * 0.08);

  const width = Math.max(320, host.clientWidth);
  const height = Math.max(320, host.clientHeight || 480);
  const camera = new THREE.PerspectiveCamera(50, width / height, radius / 1000, radius * 100);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);
  host.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.copy(center);

  const grid = new THREE.GridHelper(radius * 4, 20, inactiveColor, inactiveColor);
  (grid.material as THREE.Material).opacity = 0.25;
  (grid.material as THREE.Material).transparent = true;
  grid.position.copy(center);
  scene.add(grid);

  const worldAxes = new THREE.AxesHelper(radius * 0.5);
  scene.add(worldAxes);

  const maxPoses = frames.reduce((m, f) => Math.max(m, f.poseSet.poses.length), 1);
  const sphere = new THREE.SphereGeometry(pointRadius, 12, 12);
  const material = new THREE.MeshBasicMaterial();
  const points = new THREE.InstancedMesh(sphere, material, maxPoses);
  points.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(points);

  // Pool of orientation triads, one per possible pose, toggled per frame.
  const axesPool: THREE.AxesHelper[] = [];
  const axesGroup = new THREE.Group();
  for (let i = 0; i < maxPoses; i++) {
    const a = new THREE.AxesHelper(axisSize);
    a.visible = false;
    axesPool.push(a);
    axesGroup.add(a);
  }
  scene.add(axesGroup);

  const dummy = new THREE.Object3D();
  const hidden = new THREE.Object3D();
  hidden.scale.setScalar(0);
  hidden.updateMatrix();

  const applyUp = (zUp: boolean) => {
    camera.up.set(0, zUp ? 0 : 1, zUp ? 1 : 0);
    // Default GridHelper lies in the XZ plane; rotate it into XY for Z-up.
    grid.rotation.x = zUp ? Math.PI / 2 : 0;
    controls.update();
  };

  // Frame the whole cloud from a pleasant diagonal.
  camera.position.set(center.x + radius * 1.6, center.y + radius * 1.6, center.z + radius * 1.6);
  applyUp(true);

  let running = true;
  const renderLoop = () => {
    if (!running) {
      return;
    }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(renderLoop);
  };
  requestAnimationFrame(renderLoop);

  const resize = new ResizeObserver(() => {
    const w = Math.max(320, host.clientWidth);
    const h = Math.max(320, host.clientHeight || 480);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resize.observe(host);

  const showFrame = (index: number, opts: { showAxes: boolean; zUp: boolean }) => {
    const frame = frames[index];
    if (!frame) {
      return;
    }
    applyUp(opts.zUp);
    const poses = frame.poseSet.poses;
    for (let i = 0; i < maxPoses; i++) {
      const pose = poses[i];
      const triad = axesPool[i]!;
      if (!pose) {
        points.setMatrixAt(i, hidden.matrix);
        triad.visible = false;
        continue;
      }
      dummy.position.set(pose.position[0], pose.position[1], pose.position[2]);
      dummy.quaternion.identity();
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      points.setMatrixAt(i, dummy.matrix);
      points.setColorAt(i, pose.active ? activeColor : inactiveColor);

      if (opts.showAxes && pose.quaternion) {
        triad.visible = true;
        triad.position.copy(dummy.position);
        triad.quaternion.set(pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]);
      } else {
        triad.visible = false;
      }
    }
    points.instanceMatrix.needsUpdate = true;
    if (points.instanceColor) {
      points.instanceColor.needsUpdate = true;
    }
  };

  return {
    showFrame,
    dispose() {
      running = false;
      resize.disconnect();
      controls.dispose();
      sphere.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    },
  };
}

/** Bounding center + radius over every pose in every frame (>0). */
function boundsOf(frames: Frame[]): { center: THREE.Vector3; radius: number } {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let any = false;
  for (const f of frames) {
    for (const p of f.poseSet.poses) {
      v.set(p.position[0], p.position[1], p.position[2]);
      box.expandByPoint(v);
      any = true;
    }
  }
  if (!any) {
    return { center: new THREE.Vector3(), radius: 1 };
  }
  const center = new THREE.Vector3();
  box.getCenter(center);
  const radius = Math.max(0.1, box.getSize(v).length() / 2);
  return { center, radius };
}
