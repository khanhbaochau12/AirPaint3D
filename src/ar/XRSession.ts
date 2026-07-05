import * as THREE from 'three';

export interface XRResult {
  session: XRSession;
  hitTestSource: XRHitTestSource | null;
  refSpace: XRReferenceSpace;
}

/**
 * Khởi tạo WebXR AR session.
 *
 * Yêu cầu:
 * - Chrome 81+ trên Android / iOS
 * - HTTPS (localhost OK cho dev)
 * - Thiết bị hỗ trợ ARCore / ARKit
 *
 * Features sử dụng:
 * - hit-test:    Phát hiện bề mặt thực (sàn, bàn) để đặt canvas vẽ
 * - dom-overlay: Hiển thị UI HTML đè lên camera feed
 * - light-estimation: Điều chỉnh shading theo ánh sáng thực (Chrome 90+)
 */
export async function isARSupported(): Promise<boolean> {
  if (!navigator.xr) return false;
  return navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
}

/**
 * LƯU Ý: requestSession() bắt buộc phải được gọi từ một user gesture
 * (click handler) — gọi tự động lúc init sẽ luôn bị trình duyệt chặn.
 */
export async function initXR(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene
): Promise<XRResult | null> {

  const xr = navigator.xr;
  if (!xr || !(await isARSupported())) {
    console.warn('[XR] immersive-ar không được hỗ trợ trên thiết bị này');
    return null;
  }

  // Yêu cầu session
  let session: XRSession;
  try {
    session = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: [
        'dom-overlay',
        'light-estimation',
        'depth-sensing',       // Android Chrome 92+ với ARCore
      ],
      domOverlay: {
        root: document.getElementById('ar-overlay') ?? document.body
      },
    });
  } catch (err) {
    console.error('[XR] Không thể mở AR session:', err);
    return null;
  }

  // Kết nối với Three.js renderer
  renderer.xr.enabled = true;
  await renderer.xr.setSession(session);

  // Reference space — 'local' = relative to initial head position
  const refSpace = await session.requestReferenceSpace('local');

  // Hit-test source — cho phép detect bề mặt thực
  let hitTestSource: XRHitTestSource | null = null;
  try {
    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource =
      (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
  } catch (err) {
    console.warn('[XR] Hit-test không khả dụng:', err);
  }

  // Light estimation — shading thực tế
  session.addEventListener('end', () => {
    hitTestSource?.cancel();
    renderer.xr.enabled = false;
    console.log('[XR] Session ended');
  });

  // Nếu có light estimation, cập nhật DirectionalLight
  setupLightEstimation(session, renderer, scene);

  console.log('[XR] AR session started ✓');
  return { session, hitTestSource, refSpace };
}

/**
 * Sử dụng XRLightEstimate để update DirectionalLight trong scene.
 * Tạo hiệu ứng 3D strokes phản chiếu ánh sáng thực tế.
 */
async function setupLightEstimation(
  session: XRSession,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene
): Promise<void> {
  // Chỉ chạy nếu feature được grant
  const lightProbe = await (session as any).requestLightProbe?.().catch(() => null);
  if (!lightProbe) return;

  const dirLight = new THREE.DirectionalLight();
  scene.add(dirLight);
  session.addEventListener('end', () => scene.remove(dirLight));

  lightProbe.addEventListener('reflectionchange', () => {
    const est: any = lightProbe.getReflectionCubeMap?.(renderer.xr.getCamera?.());
    if (!est) return;

    // Ánh sáng hướng (primary light source)
    dirLight.intensity = est.primaryLightIntensity?.value ?? 1;
    if (est.primaryLightDirection) {
      dirLight.position.set(
        est.primaryLightDirection.x,
        est.primaryLightDirection.y,
        est.primaryLightDirection.z,
      );
    }
    if (est.primaryLightColor) {
      dirLight.color.setRGB(
        est.primaryLightColor.r,
        est.primaryLightColor.g,
        est.primaryLightColor.b,
      );
    }
  });
}

// ──────────────────────────────────────────────────────────
// HIT TEST UTIL
// ──────────────────────────────────────────────────────────

/**
 * Thực hiện hit-test trong frame XR, trả về vị trí và normal của bề mặt phát hiện.
 * Dùng để "dán" canvas vẽ lên sàn / bàn thực tế.
 */
export function getHitTestResult(
  hitTestSource: XRHitTestSource,
  frame: XRFrame,
  refSpace: XRReferenceSpace
): THREE.Matrix4 | null {

  const results = frame.getHitTestResults(hitTestSource);
  if (!results.length) return null;

  const pose = results[0].getPose(refSpace);
  if (!pose) return null;

  const m = pose.transform.matrix;
  return new THREE.Matrix4().fromArray(m);
}
