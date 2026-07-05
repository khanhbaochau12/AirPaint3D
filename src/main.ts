import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass';
import {
  GestureDetector, GestureEvent, GestureType, HAND_CONNECTIONS,
} from './cv/GestureDetector';
import { BrushType, StrokeEngine } from './render/StrokeEngine';
import { Environment } from './render/Environment';
import { SparkSystem } from './render/Sparks';
import { ShapeManager, ShapeType } from './objects/ShapeManager';
import { ObjectEditor, EditTool } from './edit/ObjectEditor';
import { PositionMapper } from './ar/PositionMapper';
import { initXR, isARSupported } from './ar/XRSession';
import { MultiplayerSync } from './net/MultiplayerSync';

// ──────────────────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────────────────

const COLORS = {
  SKY:    '#63b3ed',
  PURPLE: '#a78bfa',
  GREEN:  '#34d399',
  PINK:   '#f9a8d4',
  ORANGE: '#fb923c',
};

const STORAGE_KEY     = 'airpaint3d_scene_v1';
const AUTOSAVE_DELAY  = 500;   // ms debounce
const CURSOR_SYNC_FPS = 30;

// Các element có thể bấm bằng cử chỉ tay (chỉ ngón trỏ + chụm)
const UI_SELECTOR       = '.ctrl-btn, .color-swatch, [data-brush]';
const UI_CLICK_COOLDOWN = 600;   // ms — chặn double-click do jitter

// Bloom — làm nét neon phát sáng thật
const BLOOM_STRENGTH  = 0.85;
const BLOOM_RADIUS    = 0.5;
const BLOOM_THRESHOLD = 0.12;

// Tự xoay khoe tranh khi rảnh tay
const IDLE_ROTATE_MS    = 15000;
const IDLE_ROTATE_SPEED = 0.6;

// Khoảng cách thả hình khối trước camera
const SPAWN_DISTANCE = 1.6;

// Toolbar tự thu gọn dưới ngưỡng này
const COLLAPSE_WIDTH = 700;

type AppMode = 'draw' | 'edit';

const GESTURE_LABELS: Record<GestureType, string> = {
  PINCH:  '🤏 Đang vẽ',
  POINT:  '☝ Di chuyển',
  FIST:   '✊ Dừng',
  SPREAD: '🖐 Xóa nét cuối',
  NONE:   '— Không thấy tay',
};

const GESTURE_LABELS_EDIT: Record<GestureType, string> = {
  PINCH:  '🤏 Đang kéo vật thể',
  POINT:  '☝ Chọn vật thể',
  FIST:   '✊ Thả',
  SPREAD: '🖐 —',
  NONE:   '— Không thấy tay',
};

// ──────────────────────────────────────────────────────────
// APP CLASS
// ──────────────────────────────────────────────────────────

class AirPaintApp {
  // Three.js
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private composer!: EffectComposer;
  private clock = new THREE.Clock();

  // Core modules
  private strokeEngine!: StrokeEngine;
  private positionMapper!: PositionMapper;
  private gestureDetector?: GestureDetector;
  private environment!: Environment;
  private sparks!: SparkSystem;
  private shapeManager!: ShapeManager;
  private editor!: ObjectEditor;

  // Media
  private video?: HTMLVideoElement;

  // State
  private appMode: AppMode = 'draw';
  private isDrawing = false;
  private currentColor = COLORS.SKY;
  private brushRadius  = 0.015;
  private currentBrush: BrushType = 'normal';
  private lastGesture: GestureType = 'NONE';
  private autosaveTimer?: number;
  private lastCursorSync = 0;
  private lastActivity = performance.now();
  private prevNorm: { x: number; y: number } | null = null;

  // Hand cursor — bấm nút UI bằng cử chỉ
  private handCursorEl: HTMLElement | null = null;
  private hoveredEl: Element | null = null;
  private uiPinchActive = false;
  private lastUiClick = 0;

  // Optional
  private multiplayer?: MultiplayerSync;
  private remoteCursors = new Map<string, THREE.Mesh>();

  // ────────────────────────────────────────────────────────
  // INIT
  // ────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.setupRenderer();
    this.setupScene();
    this.setupCamera();
    this.setupComposer();
    this.setupLighting();
    this.setupUI();
    this.setupARButton();
    this.setupMultiplayer();
    this.restoreFromStorage();

    // Camera được bật từ overlay onboarding —
    // getUserMedia + requestSession cần user gesture mới thân thiện.
    this.setupOnboarding();

    // Hook kiểm thử: mô phỏng GestureEvent + soi trạng thái từ console khi có ?debug
    if (new URLSearchParams(location.search).has('debug')) {
      const w = window as unknown as Record<string, unknown>;
      w.__gesture = (e: GestureEvent) => this.handleGesture(e);
      w.__app = this;
    }

    this.startRenderLoop();
  }

  // ────────────────────────────────────────────────────────
  // THREE.JS SETUP
  // ────────────────────────────────────────────────────────

  private setupRenderer(): void {
    const canvas = document.getElementById('main-canvas') as HTMLCanvasElement | null;
    if (!canvas) {
      throw new Error('[AirPaint] Không tìm thấy #main-canvas trong DOM');
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping      = THREE.ACESFilmicToneMapping;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer?.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private setupScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050811);
    this.scene.fog = new THREE.Fog(0x050811, 8, 20);

    this.environment = new Environment(this.scene);
    this.sparks      = new SparkSystem(this.scene);
    this.shapeManager = new ShapeManager(this.scene);

    this.strokeEngine = new StrokeEngine(this.scene, {
      color:       this.currentColor,
      brushRadius: this.brushRadius,
    });

    this.strokeEngine.onStrokeCommitted = (data) => {
      this.multiplayer?.broadcastStroke(data);
      this.scheduleAutosave();
      this.updateStrokeCount();
    };

    // Editor chỉnh sửa vật thể: raycast trên strokes + shapes
    this.editor = new ObjectEditor(
      this.scene,
      () => [...this.strokeEngine.meshes, ...this.shapeManager.meshes],
      (obj) => {
        // Đồng bộ transform vào data để autosave giữ được vị trí mới
        if (!this.shapeManager.syncTransform(obj)) {
          this.strokeEngine.syncTransform(obj);
        }
        this.scheduleAutosave();
      }
    );
  }

  private setupCamera(): void {
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.01,
      100
    );
    this.camera.position.set(0, 0, 3.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.enableZoom = true;
    this.controls.autoRotateSpeed = IDLE_ROTATE_SPEED;
    this.controls.addEventListener('start', () => { this.lastActivity = performance.now(); });

    this.positionMapper = new PositionMapper(this.camera, {
      depthRange:    [0.2, 2.0],
      handSizeRange: [0.06, 0.45],
    });
  }

  /** Bloom postprocessing — nét neon phát sáng thật. */
  private setupComposer(): void {
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.composer.setSize(window.innerWidth, window.innerHeight);

    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD
    ));
    this.composer.addPass(new OutputPass());
  }

  private setupLighting(): void {
    // Ambient
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));

    // Key light
    const key = new THREE.DirectionalLight(0x63b3ed, 1.5);
    key.position.set(3, 5, 3);
    this.scene.add(key);

    // Fill light
    const fill = new THREE.DirectionalLight(0xa78bfa, 0.8);
    fill.position.set(-3, -2, 2);
    this.scene.add(fill);

    // Rim light
    const rim = new THREE.DirectionalLight(0x34d399, 0.4);
    rim.position.set(0, 5, -5);
    this.scene.add(rim);
  }

  // ────────────────────────────────────────────────────────
  // ONBOARDING — app điều khiển 100% bằng cử chỉ tay,
  // camera là bắt buộc; bị từ chối quyền thì cho thử lại
  // ────────────────────────────────────────────────────────

  private setupOnboarding(): void {
    const overlay  = document.getElementById('onboarding');
    const errorMsg = document.getElementById('camera-error');
    const btn      = document.getElementById('btn-start-camera') as HTMLButtonElement | null;

    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      const ok = await this.setupCameraFeed();
      btn.disabled = false;

      if (ok) {
        overlay?.classList.add('hidden');
        errorMsg?.classList.add('hidden');
        this.setupGestureDetector();
        this.setModeLabel('Điều khiển bằng cử chỉ tay');
        document.getElementById('gesture-legend')?.classList.remove('hidden');
      } else {
        errorMsg?.classList.remove('hidden');
      }
    });
  }

  private setModeLabel(text: string): void {
    const el = document.getElementById('mode-label');
    if (el) el.textContent = text;
  }

  // ────────────────────────────────────────────────────────
  // CAMERA FEED — hiển thị PiP để người dùng thấy tay mình
  // ────────────────────────────────────────────────────────

  private async setupCameraFeed(): Promise<boolean> {
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width:       { ideal: 1280 },
          height:      { ideal: 720 },
          facingMode:  'user',
          frameRate:   { ideal: 30 },
        },
      });
      this.video.srcObject = stream;
      await this.video.play();

      // Picture-in-picture ở góc màn hình — thiết yếu để người dùng
      // canh vị trí tay (CSS .camera-pip mirror sẵn bằng scaleX(-1))
      const pip = document.getElementById('camera-pip');
      if (pip) {
        pip.insertBefore(this.video, pip.firstChild);
        pip.classList.remove('hidden');
      }
      return true;
    } catch (err) {
      console.warn('[AirPaint] Camera không khả dụng:', err);
      return false;
    }
  }

  // ────────────────────────────────────────────────────────
  // GESTURE DETECTOR
  // ────────────────────────────────────────────────────────

  private setupGestureDetector(): void {
    this.gestureDetector = new GestureDetector((event: GestureEvent) => {
      this.handleGesture(event);
    });
  }

  private handleGesture(event: GestureEvent): void {
    this.updateGestureStatus(event.gesture);
    this.drawHandSkeleton(event.landmarks);
    const overUI = this.updateHandCursor(event);

    // Mất tracking — commit stroke dở dang, reset filter, ẩn cursor
    if (event.gesture === 'NONE') {
      this.stopDrawing();
      this.editor.release();
      this.positionMapper.reset();
      if (this.cursorSphere) this.cursorSphere.visible = false;
      this.uiPinchActive = false;
      this.prevNorm = null;
      this.lastGesture = 'NONE';
      return;
    }

    this.lastActivity = performance.now();

    const worldPos = this.positionMapper.map(
      event.indexTip.x,
      event.indexTip.y,
      event.handSize
    );

    // Tọa độ chuẩn hóa màn hình (đã flip gương) + delta so với frame trước
    const nx = 1 - event.indexTip.x;
    const ny = event.indexTip.y;
    const dx = this.prevNorm ? nx - this.prevNorm.x : 0;
    const dy = this.prevNorm ? ny - this.prevNorm.y : 0;
    this.prevNorm = { x: nx, y: ny };
    const ndc = new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1));

    this.syncCursor(worldPos);

    switch (event.gesture) {
      case 'PINCH': {
        // Chụm trên nút UI = bấm nút (edge-trigger + cooldown), không vẽ
        const pinchEdge = this.lastGesture !== 'PINCH';
        if (pinchEdge && overUI) {
          const now = performance.now();
          if (now - this.lastUiClick > UI_CLICK_COOLDOWN) {
            (this.hoveredEl as HTMLElement | null)?.click();
            this.lastUiClick = now;
          }
          this.uiPinchActive = true;
        }
        // Pinch bắt đầu trên UI → không vẽ/kéo cho tới khi thả tay
        if (this.uiPinchActive) break;

        if (this.appMode === 'edit') {
          // Chụm vào vật thể = grab; giữ chụm = kéo theo công cụ hiện tại
          if (pinchEdge) {
            this.editor.tryGrab(ndc, this.camera, worldPos);
          } else if (this.editor.isGrabbing) {
            this.editor.drag(worldPos, dx, dy);
          }
          this.updateCursorIndicator(worldPos, this.editor.isGrabbing);
          break;
        }

        this.controls.enabled = false;  // Tắt orbit khi vẽ
        this.strokeEngine.addPoint(worldPos);
        this.sparks.emit(worldPos, new THREE.Color(this.currentColor), 2);
        this.isDrawing = true;
        this.updateCursorIndicator(worldPos, true);
        break;
      }

      case 'POINT':
        // Di chuyển cursor
        this.uiPinchActive = false;
        if (this.appMode === 'edit') {
          this.editor.release();
          this.editor.updateHover(ndc, this.camera);
        } else if (this.isDrawing) {
          this.stopDrawing();
          this.positionMapper.reset();  // Reset filter tránh lurch
        }
        this.updateCursorIndicator(worldPos, false);
        break;

      case 'FIST':
        // Dừng hẳn / thả vật thể
        this.uiPinchActive = false;
        this.editor.release();
        this.stopDrawing();
        break;

      case 'SPREAD':
        // Edge-trigger: chỉ undo MỘT LẦN khi gesture chuyển sang SPREAD,
        // nếu không giữ tay xòe 1 giây sẽ xóa sạch ~30 strokes.
        // Chế độ chỉnh sửa: SPREAD không xóa gì (tránh xóa nhầm vật thể).
        this.uiPinchActive = false;
        this.editor.release();
        if (this.appMode === 'draw' && this.lastGesture !== 'SPREAD') {
          this.undo();
        }
        break;
    }

    this.lastGesture = event.gesture;
  }

  private stopDrawing(): void {
    if (!this.isDrawing) return;
    this.strokeEngine.commitStroke();
    this.isDrawing = false;
    this.controls.enabled = true;
  }

  private updateGestureStatus(gesture: GestureType): void {
    const el = document.getElementById('gesture-status');
    if (!el) return;
    el.textContent = this.appMode === 'edit'
      ? GESTURE_LABELS_EDIT[gesture]
      : GESTURE_LABELS[gesture];
  }

  // ────────────────────────────────────────────────────────
  // HAND SKELETON — vẽ 21 khớp tay lên camera PiP
  // ────────────────────────────────────────────────────────

  private drawHandSkeleton(landmarks?: GestureEvent['landmarks']): void {
    const canvas = document.getElementById('pip-skeleton') as HTMLCanvasElement | null;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (!landmarks) return;

    // Mirror X — khớp với video PiP đang scaleX(-1)
    const px = (i: number) => ((1 - landmarks[i].x) * w);
    const py = (i: number) => (landmarks[i].y * h);

    ctx.strokeStyle = 'rgba(99, 179, 237, 0.9)';
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(px(a), py(a));
      ctx.lineTo(px(b), py(b));
      ctx.stroke();
    }

    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < landmarks.length; i++) {
      ctx.beginPath();
      ctx.arc(px(i), py(i), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ────────────────────────────────────────────────────────
  // HAND CURSOR — con trỏ theo ngón trỏ, bấm nút bằng PINCH
  // ────────────────────────────────────────────────────────

  /** Cập nhật vị trí con trỏ tay trên màn hình. Trả về true nếu đang trỏ vào UI. */
  private updateHandCursor(event: GestureEvent): boolean {
    if (!this.handCursorEl) {
      this.handCursorEl = document.getElementById('hand-cursor');
    }
    const el = this.handCursorEl;
    if (!el) return false;

    if (event.gesture === 'NONE') {
      el.classList.add('hidden');
      this.setHovered(null);
      return false;
    }

    // Flip X — khớp với hình ảnh gương của camera
    const x = (1 - event.indexTip.x) * window.innerWidth;
    const y = event.indexTip.y * window.innerHeight;
    el.classList.remove('hidden');
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.classList.toggle('pinching', event.gesture === 'PINCH');

    // #hand-cursor có pointer-events: none nên không tự che elementFromPoint
    const target = document.elementFromPoint(x, y)?.closest(UI_SELECTOR) ?? null;
    this.setHovered(target);
    return target !== null;
  }

  private setHovered(el: Element | null): void {
    if (this.hoveredEl === el) return;
    this.hoveredEl?.classList.remove('gesture-hover');
    el?.classList.add('gesture-hover');
    this.hoveredEl = el;
  }

  // ────────────────────────────────────────────────────────
  // CURSOR INDICATOR (3D sphere theo ngón tay)
  // ────────────────────────────────────────────────────────

  private cursorSphere?: THREE.Mesh;

  private updateCursorIndicator(pos: THREE.Vector3, isActive: boolean): void {
    if (!this.cursorSphere) {
      const geo = new THREE.SphereGeometry(0.025, 16, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        wireframe: true,
        transparent: true,
        opacity: 0.6,
      });
      this.cursorSphere = new THREE.Mesh(geo, mat);
      this.scene.add(this.cursorSphere);
    }

    this.cursorSphere.visible = true;
    this.cursorSphere.position.copy(pos);
    (this.cursorSphere.material as THREE.MeshBasicMaterial).color.set(
      isActive ? this.currentColor : 0xffffff
    );
  }

  // ────────────────────────────────────────────────────────
  // MODE + SHAPE LIBRARY + EDIT TOOLS
  // ────────────────────────────────────────────────────────

  private setMode(mode: AppMode): void {
    this.appMode = mode;
    document.querySelectorAll<HTMLElement>('[data-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    document.getElementById('edit-tools')?.classList.toggle('hidden', mode !== 'edit');

    if (mode === 'draw') {
      this.editor.reset();
    } else {
      this.stopDrawing();
    }
  }

  private setTool(tool: EditTool): void {
    this.editor.tool = tool;
    document.querySelectorAll<HTMLElement>('[data-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
  }

  /** Thả hình khối từ thư viện vào trước camera, tự chuyển sang chế độ chỉnh sửa. */
  private spawnShape(type: ShapeType): void {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const pos = this.camera.position.clone().add(dir.multiplyScalar(SPAWN_DISTANCE));
    pos.x += (Math.random() - 0.5) * 0.3;
    pos.y += (Math.random() - 0.5) * 0.2;

    const mesh = this.shapeManager.add(type, this.currentColor, pos);
    this.setMode('edit');
    this.editor.select(mesh);   // chọn sẵn — chụm là kéo được ngay
    this.scheduleAutosave();
    this.updateStrokeCount();
  }

  private deleteSelectedObject(): void {
    const obj = this.editor.takeSelected();
    if (!obj) return;

    if (!this.shapeManager.remove(obj)) {
      this.strokeEngine.removeByMesh(obj);
    }
    this.scheduleAutosave();
    this.updateStrokeCount();
  }

  // ────────────────────────────────────────────────────────
  // WEBXR — nút Enter AR (requestSession cần user gesture)
  // ────────────────────────────────────────────────────────

  private setupARButton(): void {
    const btn = document.getElementById('btn-ar') as HTMLButtonElement | null;
    if (!btn) return;

    isARSupported().then(supported => {
      if (!supported) return;   // Giữ nút ẩn trên desktop
      btn.classList.remove('hidden');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const xr = await initXR(this.renderer, this.scene);
        if (xr) {
          console.log('[AirPaint] WebXR AR session active');
          xr.session.addEventListener('end', () => { btn.disabled = false; });
        } else {
          btn.disabled = false;
        }
      });
    });
  }

  // ────────────────────────────────────────────────────────
  // MULTIPLAYER — bật bằng URL param: app.html?ws=wss://server
  // ────────────────────────────────────────────────────────

  private setupMultiplayer(): void {
    const wsUrl = new URLSearchParams(location.search).get('ws');
    if (!wsUrl) return;

    const statusEl = document.getElementById('mp-status');
    statusEl?.classList.remove('hidden');

    this.multiplayer = new MultiplayerSync(wsUrl, this.strokeEngine, {
      onStatusChange: (status) => {
        if (statusEl) {
          statusEl.textContent =
            status === 'connected'  ? 'Multiplayer: đã kết nối' :
            status === 'connecting' ? 'Multiplayer: đang kết nối…' : 'Multiplayer: mất kết nối';
        }
      },
      onRemoteCursor: (userId, x, y, z) => this.updateRemoteCursor(userId, x, y, z),
      onUserLeave:    (userId) => this.removeRemoteCursor(userId),
    });
  }

  private updateRemoteCursor(userId: string, x: number, y: number, z: number): void {
    let cursor = this.remoteCursors.get(userId);
    if (!cursor) {
      const geo = new THREE.SphereGeometry(0.02, 12, 12);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xf9a8d4, transparent: true, opacity: 0.7,
      });
      cursor = new THREE.Mesh(geo, mat);
      this.scene.add(cursor);
      this.remoteCursors.set(userId, cursor);
    }
    cursor.position.set(x, y, z);
  }

  private removeRemoteCursor(userId: string): void {
    const cursor = this.remoteCursors.get(userId);
    if (!cursor) return;
    this.scene.remove(cursor);
    cursor.geometry.dispose();
    (cursor.material as THREE.Material).dispose();
    this.remoteCursors.delete(userId);
  }

  /** Broadcast vị trí cursor, throttle ~30fps. */
  private syncCursor(pos: THREE.Vector3): void {
    if (!this.multiplayer) return;
    const now = performance.now();
    if (now - this.lastCursorSync < 1000 / CURSOR_SYNC_FPS) return;
    this.lastCursorSync = now;
    this.multiplayer.broadcastCursor(pos.x, pos.y, pos.z);
  }

  // ────────────────────────────────────────────────────────
  // PERSISTENCE — autosave localStorage
  // Format v2: { version: 2, strokes: [...], shapes: [...] }
  // (v1 là mảng strokes thuần — vẫn đọc được)
  // ────────────────────────────────────────────────────────

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => this.saveToStorage(), AUTOSAVE_DELAY);
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 2,
        strokes: this.strokeEngine.exportData(),
        shapes:  this.shapeManager.serialize(),
      }));
    } catch (err) {
      console.warn('[AirPaint] Không thể autosave:', err);
    }
  }

  private restoreFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        // Format v1 — mảng strokes thuần
        this.strokeEngine.loadData(parsed);
      } else if (parsed?.version === 2) {
        this.strokeEngine.loadData(parsed.strokes ?? []);
        this.shapeManager.load(parsed.shapes ?? []);
      }

      this.updateStrokeCount();
      const total = this.strokeEngine.strokeCount + this.shapeManager.count;
      if (total > 0) {
        console.log(`[AirPaint] Khôi phục ${total} vật thể từ phiên trước`);
      }
    } catch (err) {
      console.warn('[AirPaint] Không thể khôi phục tranh đã lưu:', err);
    }
  }

  // ────────────────────────────────────────────────────────
  // SNAPSHOT — chụp PNG
  // ────────────────────────────────────────────────────────

  private saveSnapshot(): void {
    // Render lại ngay trước khi đọc buffer (không cần preserveDrawingBuffer)
    this.composer.render();
    const url = this.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `airpaint_${Date.now()}.png`;
    a.click();
  }

  // ────────────────────────────────────────────────────────
  // EDIT ACTIONS
  // ────────────────────────────────────────────────────────

  private undo(): void {
    const id = this.strokeEngine.undo();
    if (id) this.multiplayer?.broadcastUndo(id);
    this.scheduleAutosave();
    this.updateStrokeCount();
  }

  private redo(): void {
    const data = this.strokeEngine.redo();
    if (data) this.multiplayer?.broadcastStroke(data);
    this.scheduleAutosave();
    this.updateStrokeCount();
  }

  private clearAll(): void {
    this.strokeEngine.clear();
    this.shapeManager.clear();
    this.editor.reset();
    this.multiplayer?.broadcastClear();
    this.scheduleAutosave();
    this.updateStrokeCount();
  }

  private updateStrokeCount(): void {
    const el = document.getElementById('stroke-count');
    if (el) {
      el.textContent = String(this.strokeEngine.strokeCount + this.shapeManager.count);
    }
  }

  // ────────────────────────────────────────────────────────
  // UI CONTROLS
  // ────────────────────────────────────────────────────────

  private setupUI(): void {
    // Color pickers
    document.querySelectorAll<HTMLElement>('[data-color]').forEach(el => {
      el.addEventListener('click', () => {
        document.querySelectorAll('[data-color]').forEach(s => s.classList.remove('active'));
        el.classList.add('active');
        this.currentColor = el.dataset.color!;
        this.strokeEngine.setOptions({ color: this.currentColor });
      });
    });

    // Brush types
    document.querySelectorAll<HTMLElement>('[data-brush]').forEach(el => {
      el.addEventListener('click', () => {
        document.querySelectorAll('[data-brush]').forEach(b => b.classList.remove('active'));
        el.classList.add('active');
        this.currentBrush = el.dataset.brush as BrushType;
        this.strokeEngine.setOptions({ brushType: this.currentBrush });
      });
    });

    // Mode: Vẽ / Chỉnh sửa
    document.querySelectorAll<HTMLElement>('[data-mode]').forEach(el => {
      el.addEventListener('click', () => this.setMode(el.dataset.mode as AppMode));
    });

    // Edit tools: Di chuyển / Xoay / Thu phóng
    document.querySelectorAll<HTMLElement>('[data-tool]').forEach(el => {
      el.addEventListener('click', () => this.setTool(el.dataset.tool as EditTool));
    });

    // Thư viện hình khối
    document.getElementById('btn-library')?.addEventListener('click', () => {
      document.getElementById('shape-library')?.classList.toggle('hidden');
    });
    document.querySelectorAll<HTMLElement>('[data-shape]').forEach(el => {
      el.addEventListener('click', () => this.spawnShape(el.dataset.shape as ShapeType));
    });

    document.getElementById('btn-delete-object')?.addEventListener('click', () => {
      this.deleteSelectedObject();
    });

    document.getElementById('btn-undo')?.addEventListener('click', () => this.undo());
    document.getElementById('btn-redo')?.addEventListener('click', () => this.redo());
    document.getElementById('btn-clear')?.addEventListener('click', () => this.clearAll());
    document.getElementById('btn-snapshot')?.addEventListener('click', () => this.saveSnapshot());

    document.getElementById('btn-export')?.addEventListener('click', async () => {
      await this.strokeEngine.exportGLTF();
    });

    // Brush size
    document.getElementById('brush-size')?.addEventListener('input', (e) => {
      const val = parseInt((e.target as HTMLInputElement).value);
      this.brushRadius = val / 1000;   // slider 1–50 → 0.001–0.05
      this.strokeEngine.setOptions({ brushRadius: this.brushRadius });
    });

    // Toolbar thu gọn — mặc định gọn trên màn hình hẹp
    const toolbar = document.getElementById('toolbar');
    document.getElementById('btn-toolbar-toggle')?.addEventListener('click', () => {
      toolbar?.classList.toggle('collapsed');
    });
    if (window.innerWidth < COLLAPSE_WIDTH) {
      toolbar?.classList.add('collapsed');
    }

    // Mọi tương tác chuột cũng tính là hoạt động (tắt auto-rotate)
    window.addEventListener('pointerdown', () => { this.lastActivity = performance.now(); });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z' && e.shiftKey) { e.preventDefault(); this.redo(); return; }
      if (ctrl && e.key === 'z')  { e.preventDefault(); this.undo(); }
      if (ctrl && e.key === 'y')  { e.preventDefault(); this.redo(); }
      if (ctrl && e.key === 'e')  { e.preventDefault(); this.strokeEngine.exportGLTF(); }
      if (ctrl && e.key === 's')  { e.preventDefault(); this.saveSnapshot(); }
      if (e.key === 'Escape')     this.stopDrawing();
      if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey) {
        this.clearAll();
      }
    });
  }

  // ────────────────────────────────────────────────────────
  // RENDER LOOP — setAnimationLoop để tương thích WebXR
  // ────────────────────────────────────────────────────────

  private startRenderLoop(): void {
    this.renderer.setAnimationLoop(() => {
      const delta = this.clock.getDelta();

      // Gesture detection — GestureDetector tự skip frame nếu đang bận
      if (this.video && this.gestureDetector) {
        void this.gestureDetector.detect(this.video);
      }

      this.sparks.update(delta);
      this.environment.update(delta);

      // Tự xoay khoe tranh khi rảnh tay
      this.controls.autoRotate =
        performance.now() - this.lastActivity > IDLE_ROTATE_MS &&
        !this.isDrawing && !this.editor.isGrabbing;
      this.controls.update();

      // Composer không hỗ trợ WebXR — trong AR render trực tiếp
      if (this.renderer.xr.isPresenting) {
        this.renderer.render(this.scene, this.camera);
      } else {
        this.composer.render();
      }
    });
  }
}

// ──────────────────────────────────────────────────────────
// BOOTSTRAP
// ──────────────────────────────────────────────────────────

const app = new AirPaintApp();
app.init().catch(console.error);
