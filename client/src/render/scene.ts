import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BALL_R, CORNER_MOUTH, FOOT_SPOT_X, HEAD_STRING_X, SIDE_MOUTH, TABLE_L, TABLE_W,
} from '@shared/constants';
import type { Ball, BallPos } from '@shared/physics';
import { POCKET_CENTERS } from '@shared/physics';
import {
  backgroundTexture, ballTexture, blobTexture, clothBakedTexture, clothTexture, floorTexture, lineShadowTexture, woodTexture,
} from './textures';

export type Quality = 'high' | 'low';

/** Card đồ họa yếu / vẽ bằng CPU -> dùng chế độ nhẹ. */
const WEAK_GPU = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|geforce\s*(\d{3}m?\b|[89]\d{3}|gt\s*[1-6]\d{2}\b|gts?\s*[2-4]\d{2}\b|fx)|quadro\s*(fx|nvs)|radeon\s*(hd\s*[2-7]\d{3}|r[57]\s*2\d{2})|intel.*(gma|g[34]\d|hd graphics(\s*[2-5]\d{2,3})?\b)|mali-[t4]|adreno.*\b[3-5]\d{2}\b|powervr/i;

/** Tên card đồ họa (nếu trình duyệt cho biết). */
export function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}

/** Chất lượng đồ họa: lựa chọn đã lưu, hoặc tự đoán theo card đồ họa. */
export function pickQuality(gpu: string): Quality {
  try {
    const saved = localStorage.getItem('bia.quality');
    if (saved === 'high' || saved === 'low') return saved;
  } catch { /* bỏ qua */ }
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  return WEAK_GPU.test(gpu) || small ? 'low' : 'high';
}

export type ViewMode = 'angled' | 'top' | 'cue';

export interface CueState {
  visible: boolean;
  x: number; y: number; // vị trí bi cái (toạ độ bàn)
  dx: number; dy: number;
  pull: number; // mét
  spinX: number; spinY: number;
}

export interface GuideState {
  visible: boolean;
  x: number; y: number;
  dx: number; dy: number;
}

const L = TABLE_L, W = TABLE_W, R = BALL_R;
const HL = L / 2, HW = W / 2;
const CW = 0.05; // bề rộng băng
const RW = 0.12; // bề rộng thành gỗ
const RH = 0.046; // chiều cao mặt thành gỗ
const CH = 0.04; // chiều cao băng
const HX = HL + CW, HY = HW + CW; // mép sau của băng
const APRON = 0.17;
const FLOOR_Y = -0.76;
const CUE_LEN = 1.47;
const LAMP_Y = 1.9;

/** Toạ độ bàn (x, y) -> thế giới Three (X, Y, Z). Mặt phẳng "plan" dùng (px, py) = (x - L/2, y - W/2). */
export const toWorld = (x: number, y: number, h = R): THREE.Vector3 => new THREE.Vector3(x - HL, h, HW - y);

interface PocketGeo { cx: number; cy: number; r: number }
/** Hình học lỗ (toạ độ plan), cùng thứ tự với POCKET_CENTERS. */
const POCKETS: PocketGeo[] = POCKET_CENTERS.map((c, i) => {
  const px = c.x - HL, py = c.y - HW;
  if (i < 4) return { cx: px + Math.sign(px) * 0.02, cy: py + Math.sign(py) * 0.02, r: 0.08 };
  return { cx: 0, cy: py + Math.sign(py) * 0.035, r: 0.065 };
});

const P = (x: number, y: number) => new THREE.Vector2(x, y);
// đối tượng tạm dùng lại trong vòng lặp vẽ (tránh tạo rác -> tránh giật khi trình duyệt dọn bộ nhớ)
const TMP_Q = new THREE.Quaternion();
const TMP_V = new THREE.Vector3();
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_C = new THREE.Vector3();

/** Cung tròn quanh tâm lỗ từ a tới b. outward: đi vòng phía ngoài (ngược chiều kim đồng hồ). */
function arc(p: PocketGeo, a: THREE.Vector2, b: THREE.Vector2, outward: boolean): THREE.Vector2[] {
  const ta = Math.atan2(a.y - p.cy, a.x - p.cx);
  let tb = Math.atan2(b.y - p.cy, b.x - p.cx);
  if (outward) while (tb <= ta) tb += Math.PI * 2;
  else while (tb >= ta) tb -= Math.PI * 2;
  const n = 28;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = ta + ((tb - ta) * i) / n;
    pts.push(P(p.cx + Math.cos(t) * p.r, p.cy + Math.sin(t) * p.r));
  }
  return pts;
}

const onH = (p: PocketGeo, y: number, side: 1 | -1) => P(p.cx + side * Math.sqrt(p.r * p.r - (y - p.cy) ** 2), y);
const onV = (p: PocketGeo, x: number, side: 1 | -1) => P(x, p.cy + side * Math.sqrt(p.r * p.r - (x - p.cx) ** 2));

/** Hai điểm cắt giữa miệng lỗ i và mép sau của băng, theo thứ tự đi ngược chiều kim đồng hồ. */
function pocketEnds(i: number): [THREE.Vector2, THREE.Vector2] {
  const [bl, br, tl, tr, sb, st] = POCKETS;
  switch (i) {
    case 0: return [onV(bl, -HX, 1), onH(bl, -HY, 1)];
    case 1: return [onH(br, -HY, -1), onV(br, HX, 1)];
    case 2: return [onH(tl, HY, 1), onV(tl, -HX, -1)];
    case 3: return [onV(tr, HX, -1), onH(tr, HY, -1)];
    case 4: return [onH(sb, -HY, -1), onH(sb, -HY, 1)];
    default: return [onH(st, HY, 1), onH(st, HY, -1)];
  }
}

/** Đường bao mép sau của băng có khoét 6 lỗ. outward = khoét vào thành gỗ, inward = khoét vào mặt nỉ. */
function innerOutline(outward: boolean): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (const i of [4, 1, 3, 5, 2, 0]) {
    const [a, b] = pocketEnds(i);
    pts.push(...arc(POCKETS[i], a, b, outward));
  }
  return pts;
}

function roundedRect(hx: number, hy: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-hx + r, -hy);
  s.lineTo(hx - r, -hy);
  s.absarc(hx - r, -hy + r, r, -Math.PI / 2, 0, false);
  s.lineTo(hx, hy - r);
  s.absarc(hx - r, hy - r, r, 0, Math.PI / 2, false);
  s.lineTo(-hx + r, hy);
  s.absarc(-hx + r, hy - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-hx, -hy + r);
  s.absarc(-hx + r, -hy + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Hình trong mặt phẳng plan -> khối đùn lên theo trục Y thế giới, từ y0 đến y0 + h. */
function extrudeUp(shape: THREE.Shape, y0: number, h: number, bevel = 0, curveSegments = 24): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, h - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 3,
    curveSegments,
  });
  g.translate(0, 0, bevel);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

class Seg {
  mesh: THREE.Mesh;
  constructor(color: number, opacity: number, width = 0.004) {
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.002, width),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }
  set(x1: number, y1: number, x2: number, y2: number): void {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1e-4) { this.mesh.visible = false; return; }
    const a = toWorld(x1, y1, R * 0.98), b = toWorld(x2, y2, R * 0.98);
    this.mesh.position.copy(a).add(b).multiplyScalar(0.5);
    this.mesh.scale.x = len;
    this.mesh.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
    this.mesh.visible = true;
  }
}

export class TableScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private balls: THREE.Mesh[] = [];
  private shadows: THREE.Mesh[] = [];
  private sink: ({ t: number; from: THREE.Vector3; pocket: number } | null)[] = [];
  private rest: BallPos[] = [];
  private cueGroup = new THREE.Group();
  private cueShadow: THREE.Mesh;
  private ghost: THREE.Mesh;
  private segAim = new Seg(0xffffff, 0.6);
  private pocketRings: THREE.Mesh[] = [];
  private mode: ViewMode = 'angled';
  private transition: { t: number; dur: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  private cueDir = new THREE.Vector3(1, 0, 0);
  private cueBall = new THREE.Vector3();
  private clock = 0;
  private cueBlend = 1;
  private blendFromPos = new THREE.Vector3();
  private blendFromTarget = new THREE.Vector3();
  /** độ phân giải chờ áp dụng (chỉ đổi lúc màn hình đứng yên để không gây khựng khi đang xoay / bi đang chạy) */
  private pendingPr: number | null = null;
  private lastActive = 0;
  private lamp = new THREE.Group();

  // vẽ theo nhu cầu + độ phân giải động
  private dirty = true;
  private cueKey = '';
  private guideKey = '';
  private ringOn = false;
  private pr: number;
  private prMax: number;
  private frameEma = 16;
  private adaptTimer = 0;
  private warmup = 3;
  private renderedLast = false;
  /** số giây chạy mượt liên tục cần có trước khi nâng độ phân giải (tăng gấp đôi nếu vừa nâng đã phải hạ) */
  private raiseWait = 4;
  private goodTime = 0;
  private lastRaise = -1e9;

  constructor(private canvas: HTMLCanvasElement, readonly quality: Quality) {
    const high = quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: high, powerPreference: 'high-performance' });
    this.prMax = Math.min(window.devicePixelRatio || 1, high ? 1.5 : 1);
    this.pr = this.prMax;
    this.renderer.setPixelRatio(this.pr);
    this.renderer.toneMapping = high ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = false;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 40);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 0.7;
    this.controls.maxDistance = 5;
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = 1.42;
    // chuột trái = đánh, chuột phải = điểm đánh; giữ con lăn (chuột giữa) = xoay camera, lăn = zoom; hai ngón = xoay/zoom
    (this.controls as any).mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null };
    (this.controls as any).touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };

    this.buildRoom();
    this.buildTable();
    this.buildBalls();
    this.buildCue();

    this.cueShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: lineShadowTexture(), transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.cueShadow.renderOrder = 1;
    this.cueShadow.visible = false;
    this.scene.add(this.cueShadow);

    this.ghost = new THREE.Mesh(
      new THREE.RingGeometry(R * 0.88, R, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.ghost.position.y = 0.004;
    this.ghost.visible = false;
    this.ghost.renderOrder = 5;
    this.scene.add(this.ghost, this.segAim.mesh);

    for (let i = 0; i < 6; i++) {
      const p = POCKETS[i];
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(p.r - 0.012, p.r + 0.006, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false }),
      );
      ring.position.set(p.cx, RH + 0.01, -p.cy);
      ring.visible = false;
      ring.renderOrder = 6;
      this.pocketRings.push(ring);
      this.scene.add(ring);
    }

    this.resize();
    this.applyView('angled', true);
    this.precompile();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------- dựng cảnh ----------
  private buildRoom(): void {
    this.scene.background = backgroundTexture();
    if (this.quality === 'high') {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      this.scene.environmentIntensity = 0.32;
      this.scene.add(new THREE.HemisphereLight(0xe4efe8, 0x1c140e, 0.4));
      for (const x of [-0.62, 0.62]) {
        const spot = new THREE.SpotLight(0xfff1dc, 10, 0, 0.95, 0.9, 1.4);
        spot.position.set(x, 1.85, 0);
        spot.target.position.set(x * 0.85, 0, 0);
        this.scene.add(spot, spot.target);
      }
    } else {
      // máy yếu: chỉ ánh sáng rẻ (không phản chiếu môi trường, không đèn spot)
      this.scene.add(new THREE.HemisphereLight(0xfff6ea, 0x2a1d14, 1.1));
      const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
      sun.position.set(0.4, 2, 0.8);
      this.scene.add(sun);
    }

    // đèn treo trên bàn
    const lamp = this.lamp;
    const shade = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.07, 0.26), new THREE.MeshStandardMaterial({ color: 0x0f3a26, roughness: 0.45, metalness: 0.3 }));
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.65, 0.2).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xfff3d6 }));
    glow.position.y = -0.036;
    lamp.add(shade, glow);
    for (const x of [-0.7, 0.7]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1.2, 6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
      rod.position.set(x, 0.63, 0);
      lamp.add(rod);
    }
    lamp.position.y = LAMP_Y;
    this.scene.add(lamp);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: floorTexture() }));
    floor.position.y = FLOOR_Y;
    this.scene.add(floor);
  }

  private buildTable(): void {
    const t = new THREE.Group();
    const high = this.quality === 'high';
    const cloth = clothTexture();
    // mặt nỉ chiếm gần hết màn hình: dùng ánh sáng nướng sẵn, không tính đèn
    const clothMat = new THREE.MeshBasicMaterial({ map: clothBakedTexture(2 * HX, 2 * HY, [-0.62, 0.62]), toneMapped: false });
    const wood = woodTexture();
    const cushionMat = high
      ? new THREE.MeshStandardMaterial({ color: 0x0c5f32, roughness: 0.9, map: cloth })
      : new THREE.MeshLambertMaterial({ color: 0x0f6a38, map: cloth });
    const railMat = high
      ? new THREE.MeshStandardMaterial({ color: 0xffffff, map: wood, roughness: 0.38, metalness: 0.02 })
      : new THREE.MeshPhongMaterial({ color: 0xffffff, map: wood, shininess: 50, specular: 0x333333 });
    const apronMat = high
      ? new THREE.MeshStandardMaterial({ color: 0x8a6a58, map: wood, roughness: 0.5 })
      : new THREE.MeshLambertMaterial({ color: 0x8a6a58, map: wood });
    const dark = new THREE.MeshBasicMaterial({ color: 0x050505 });

    // mặt nỉ (có khoét lỗ)
    const clothGeo = new THREE.ShapeGeometry(new THREE.Shape(innerOutline(false)), 4).rotateX(-Math.PI / 2);
    t.add(new THREE.Mesh(clothGeo, clothMat));

    // thành gỗ + yếm bàn
    const outerR = 0.07;
    const rail = roundedRect(HX + RW, HY + RW, outerR);
    rail.holes.push(new THREE.Path(innerOutline(true)));
    t.add(new THREE.Mesh(extrudeUp(rail, 0, RH, 0.009, 32), railMat));
    const apron = roundedRect(HX + RW - 0.012, HY + RW - 0.012, outerR);
    apron.holes.push(new THREE.Path(innerOutline(true)));
    t.add(new THREE.Mesh(extrudeUp(apron, -APRON, APRON, 0, 16), apronMat));

    // chân bàn
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.13, -FLOOR_Y - APRON, 0.13), apronMat);
      leg.position.set(sx * (HX + RW - 0.16), (FLOOR_Y - APRON) / 2, sz * (HY + RW - 0.14));
      t.add(leg);
    }

    // băng: hai đầu vát theo miệng lỗ
    const M = CORNER_MOUTH, S = SIDE_MOUTH, J = 0.03, JS = 0.006;
    const cushion = (pts: [number, number][]) => {
      const sh = new THREE.Shape(pts.map(([x, y]) => P(x, y)));
      t.add(new THREE.Mesh(extrudeUp(sh, 0, CH, 0.004, 4), cushionMat));
    };
    for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
      cushion([[sx * (HL - M), sy * HW], [sx * S, sy * HW], [sx * (S + JS), sy * HY], [sx * (HL - M + J), sy * HY]]);
    }
    for (const sx of [-1, 1]) {
      cushion([[sx * HL, -(HW - M)], [sx * HL, HW - M], [sx * HX, HW - M + J], [sx * HX, -(HW - M + J)]]);
    }

    // lỗ: lòng lỗ tối + viền da trên mặt thành
    const linerMat = high ? new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.38, metalness: 0.1 }) : new THREE.MeshPhongMaterial({ color: 0x161616, shininess: 60 });
    const pitMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, side: THREE.BackSide });
    POCKETS.forEach((p, i) => {
      const pit = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 0.85, 0.12, 32, 1, true), pitMat);
      pit.position.set(p.cx, -0.06, -p.cy);
      t.add(pit);
      const bottom = new THREE.Mesh(new THREE.CircleGeometry(p.r, 32).rotateX(-Math.PI / 2), dark);
      bottom.position.set(p.cx, -0.11, -p.cy);
      t.add(bottom);
      const [a, b] = pocketEnds(i);
      const ta = Math.atan2(a.y - p.cy, a.x - p.cx);
      let tb = Math.atan2(b.y - p.cy, b.x - p.cx);
      while (tb <= ta) tb += Math.PI * 2;
      const liner = new THREE.Mesh(new THREE.TorusGeometry(p.r + 0.002, 0.008, 8, 48, tb - ta).rotateZ(ta).rotateX(-Math.PI / 2), linerMat);
      liner.position.set(p.cx, RH - 0.002, -p.cy);
      t.add(liner);
    });

    // chấm "kim cương" trên mặt thành
    const pearl = new THREE.MeshBasicMaterial({ color: 0xe9e3d2 });
    const diaGeo = new THREE.CircleGeometry(0.009, 4).rotateX(-Math.PI / 2);
    const addDia = (x: number, z: number) => { const m = new THREE.Mesh(diaGeo, pearl); m.position.set(x, RH + 0.0008, z); t.add(m); };
    for (const s of [-1, 1]) {
      for (const k of [-3, -2, -1, 1, 2, 3]) addDia((k * L) / 8, s * (HY + RW / 2));
      for (const k of [-1, 0, 1]) addDia(s * (HX + RW / 2), (k * W) / 4);
    }

    // vạch phá bi và các điểm đặt bi
    const mark = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false });
    const head = new THREE.Mesh(new THREE.PlaneGeometry(0.003, W).rotateX(-Math.PI / 2), mark);
    head.position.set(HEAD_STRING_X - HL, 0.0008, 0);
    t.add(head);
    for (const x of [HEAD_STRING_X, HL, FOOT_SPOT_X]) {
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.007, 16).rotateX(-Math.PI / 2), mark);
      dot.position.set(x - HL, 0.0009, 0);
      t.add(dot);
    }
    this.scene.add(t);
  }

  private buildBalls(): void {
    const high = this.quality === 'high';
    const geo = high ? new THREE.SphereGeometry(R, 32, 24) : new THREE.SphereGeometry(R, 24, 16);
    const shadowGeo = new THREE.PlaneGeometry(R * 3.4, R * 3.4).rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity: 0.8, depthWrite: false });
    for (let id = 0; id < 16; id++) {
      const mat = high
        ? new THREE.MeshPhysicalMaterial({ map: ballTexture(id), roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.3 })
        : new THREE.MeshPhongMaterial({ map: ballTexture(id), shininess: 110, specular: 0x777777 });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, R, 0);
      m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.scene.add(m);
      this.balls.push(m);
      const sh = new THREE.Mesh(shadowGeo, shadowMat);
      sh.renderOrder = 1;
      this.scene.add(sh);
      this.shadows.push(sh);
      this.sink.push(null);
    }
  }

  private buildCue(): void {
    const mat = (color: number, roughness: number, metalness = 0): THREE.Material => this.quality === 'high'
      ? new THREE.MeshStandardMaterial({ color, roughness, metalness })
      : new THREE.MeshPhongMaterial({ color, shininess: (1 - roughness) * 80 });
    const parts: [THREE.BufferGeometry, THREE.Material][] = [
      [new THREE.CylinderGeometry(0.0062, 0.0062, 0.008, 16).translate(0, 0.004, 0), mat(0x2a6fb5, 0.7)],
      [new THREE.CylinderGeometry(0.0068, 0.0062, 0.022, 16).translate(0, 0.019, 0), mat(0xf4f1e6, 0.35)],
      [new THREE.CylinderGeometry(0.0112, 0.0068, 0.72, 20).translate(0, 0.39, 0), mat(0xe8c98c, 0.32)],
      [new THREE.CylinderGeometry(0.0118, 0.0118, 0.025, 20).translate(0, 0.7625, 0), mat(0xc9a227, 0.25, 0.8)],
      [new THREE.CylinderGeometry(0.0158, 0.0118, 0.6, 20).translate(0, 1.075, 0), mat(0x2b1408, 0.28, 0.05)],
      [new THREE.CylinderGeometry(0.0161, 0.016, 0.1, 20).translate(0, 1.425, 0), mat(0x111111, 0.6)],
    ];
    for (const [g, m] of parts) this.cueGroup.add(new THREE.Mesh(g, m));
    this.cueGroup.visible = false;
    this.scene.add(this.cueGroup);
  }

  /** Biên dịch trước mọi shader để không bị khựng lần đầu một vật hiện ra. */
  private precompile(): void {
    const toggled = [this.cueGroup, this.cueShadow, this.ghost, this.segAim.mesh, ...this.pocketRings];
    const prev = toggled.map((o) => o.visible);
    toggled.forEach((o) => { o.visible = true; });
    try { this.renderer.compile(this.scene, this.camera); } catch { /* bỏ qua */ }
    toggled.forEach((o, i) => { o.visible = prev[i]; });
  }

  // ---------- bi ----------
  private placeBall(id: number, pos: THREE.Vector3, visible: boolean): void {
    this.placeBallXY(id, pos.x, pos.z, visible);
  }

  /** Đặt bi theo toạ độ thế giới (X, Z) — không tạo đối tượng mới (dùng mỗi khung hình). */
  private placeBallXY(id: number, wx: number, wz: number, visible: boolean): void {
    const m = this.balls[id];
    m.position.set(wx, R, wz);
    m.visible = visible;
    const s = this.shadows[id];
    s.position.set(wx * 1.02, 0.0015, wz * 1.02);
    s.visible = visible;
    this.dirty = true;
  }

  setBallsStatic(pos: BallPos[]): void {
    this.rest = pos;
    for (const p of pos) {
      this.balls[p.id].scale.setScalar(1);
      this.sink[p.id] = null;
      this.placeBall(p.id, toWorld(p.x, p.y), !p.pocketed);
    }
    this.guideKey = '';
  }

  /** Đặt một viên bi tại toạ độ bàn (dùng khi cầm bi cái). */
  setBall(id: number, x: number, y: number): void {
    const m = this.balls[id];
    const w = toWorld(x, y);
    if (m.visible && m.position.distanceToSquared(w) < 1e-12) return;
    this.placeBall(id, w, true);
  }

  /** Cập nhật hiển thị từ mô phỏng đang chạy. simDt: thời gian mô phỏng đã trôi qua kể từ lần gọi trước. */
  updateFromSim(balls: Ball[], simDt: number): void {
    const q = TMP_Q;
    const axis = TMP_V;
    for (const b of balls) {
      if (b.pocketed) continue;
      const m = this.balls[b.id];
      if (b.vx === 0 && b.vy === 0 && b.wz === 0 && m.position.x === b.x - HL && m.position.z === HW - b.y) continue;
      this.placeBallXY(b.id, b.x - HL, HW - b.y, true);
      const w = Math.sqrt(b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
      if (w > 1e-3 && simDt > 0) {
        axis.set(b.wx, b.wz, -b.wy).divideScalar(w);
        q.setFromAxisAngle(axis, w * simDt);
        m.quaternion.premultiply(q);
      }
    }
  }

  startSink(id: number, pocket: number): void {
    this.sink[id] = { t: 0, from: this.balls[id].position.clone(), pocket };
    this.dirty = true;
  }

  // ---------- gậy & đường ngắm ----------
  setCue(c: CueState): void {
    const key = c.visible ? `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.dx.toFixed(5)},${c.dy.toFixed(5)},${c.pull.toFixed(4)},${c.spinX.toFixed(3)},${c.spinY.toFixed(3)}` : 'off';
    if (key === this.cueKey) return;
    this.cueKey = key;
    this.dirty = true;
    this.cueGroup.visible = c.visible;
    this.cueShadow.visible = c.visible;
    if (!c.visible) return;
    const P0 = toWorld(c.x, c.y);
    const len = Math.hypot(c.dx, c.dy) || 1;
    const dir = new THREE.Vector3(c.dx / len, 0, -c.dy / len);
    const right = new THREE.Vector3(c.dy / len, 0, c.dx / len);
    const elev = 0.09;
    const axis = dir.clone().multiplyScalar(Math.cos(elev)).add(new THREE.Vector3(0, -Math.sin(elev), 0)).normalize();
    const back = R + 0.004 + Math.max(-0.05, c.pull);
    const tip = P0.clone()
      .addScaledVector(right, c.spinX * 0.5 * R)
      .add(new THREE.Vector3(0, c.spinY * 0.5 * R, 0))
      .addScaledVector(axis, -back);
    this.cueGroup.position.copy(tip);
    this.cueGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().negate());
    // bóng gậy trên mặt bàn
    const mid = tip.clone().addScaledVector(axis, -CUE_LEN / 2);
    this.cueShadow.position.set(mid.x + 0.02, 0.0018, mid.z + 0.02);
    this.cueShadow.scale.set(CUE_LEN, 1, 0.05);
    this.cueShadow.rotation.y = Math.atan2(-dir.z, dir.x);
    this.cueDir.copy(dir);
    this.cueBall.copy(P0);
  }

  setGuide(g: GuideState): void {
    const key = g.visible
      ? `${g.x.toFixed(4)},${g.y.toFixed(4)},${g.dx.toFixed(5)},${g.dy.toFixed(5)}`
      : 'off';
    if (key === this.guideKey) return;
    this.guideKey = key;
    this.dirty = true;
    if (!g.visible) {
      this.ghost.visible = false;
      this.segAim.mesh.visible = false;
      return;
    }
    const len = Math.hypot(g.dx, g.dy) || 1;
    const dx = g.dx / len, dy = g.dy / len;
    let tBall = Infinity;
    for (const b of this.rest) {
      if (b.id === 0 || b.pocketed) continue;
      const wx = b.x - g.x, wy = b.y - g.y;
      const proj = wx * dx + wy * dy;
      if (proj <= 0) continue;
      const d2 = wx * wx + wy * wy - proj * proj;
      const r2 = 4 * R * R;
      if (d2 >= r2) continue;
      const t = proj - Math.sqrt(r2 - d2);
      if (t < tBall) tBall = t;
    }
    let tWall = Infinity;
    if (dx > 1e-6) tWall = Math.min(tWall, (L - R - g.x) / dx); else if (dx < -1e-6) tWall = Math.min(tWall, (R - g.x) / dx);
    if (dy > 1e-6) tWall = Math.min(tWall, (W - R - g.y) / dy); else if (dy < -1e-6) tWall = Math.min(tWall, (R - g.y) / dy);
    const t = Math.max(0, Math.min(tBall, tWall));
    const gx = g.x + dx * t, gy = g.y + dy * t;
    this.segAim.set(g.x + dx * R, g.y + dy * R, gx, gy);
    this.ghost.position.set(gx - HL, 0.004, HW - gy);
    this.ghost.visible = true;
  }

  showPocket(i: number | null): void {
    const on = i !== null;
    if (!on && !this.ringOn) return;
    this.ringOn = on;
    this.pocketRings.forEach((r, k) => { r.visible = k === i; });
    this.dirty = true;
  }

  // ---------- camera ----------
  private fitDistance(): number {
    const f = (this.camera.fov * Math.PI) / 180;
    const portrait = this.camera.aspect < 1;
    const along = portrait ? W : L;
    const across = portrait ? L : W;
    const byW = (along * 1.36) / (2 * Math.tan(f / 2) * this.camera.aspect);
    const byH = (across * (portrait ? 1.28 : 2.0)) / (2 * Math.tan(f / 2));
    return Math.max(byW, byH);
  }

  private viewGoal(mode: ViewMode): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const d = this.fitDistance();
    const portrait = this.camera.aspect < 1;
    if (mode === 'top') return { pos: portrait ? new THREE.Vector3(0.001, d * 0.98, 0) : new THREE.Vector3(0, d * 0.98, 0.001), target: new THREE.Vector3() };
    const el = 0.98;
    const h = Math.sin(el) * d * 0.93, r = Math.cos(el) * d * 0.93;
    return portrait
      ? { pos: new THREE.Vector3(r, h, 0), target: new THREE.Vector3(0.04, 0, 0) }
      : { pos: new THREE.Vector3(0, h, r), target: new THREE.Vector3(0, 0, 0.04) };
  }

  /** dur: thời gian chuyển camera (giây) */
  setView(mode: ViewMode, dur = 0.7): void {
    this.applyView(mode, false, dur);
  }

  get view(): ViewMode {
    return this.mode;
  }

  private applyView(mode: ViewMode, instant: boolean, dur = 0.7): void {
    this.mode = mode;
    this.controls.enabled = mode !== 'cue';
    this.dirty = true;
    if (mode === 'cue') {
      this.cueBlend = instant ? 1 : 0;
      this.blendFromPos.copy(this.camera.position);
      this.blendFromTarget.copy(this.controls.target);
      return;
    }
    const goal = this.viewGoal(mode);
    if (instant) {
      this.camera.position.copy(goal.pos);
      this.controls.target.copy(goal.target);
      this.camera.lookAt(goal.target);
      this.controls.update();
    } else {
      this.transition = { t: 0, dur, fromPos: this.camera.position.clone(), toPos: goal.pos, fromTarget: this.controls.target.clone(), toTarget: goal.target };
    }
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.mode !== 'cue') this.applyView(this.mode, true);
    this.dirty = true;
  }

  /** Chuyển toạ độ màn hình sang toạ độ bàn (tại độ cao tâm bi). */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -R), hit)) return null;
    return { x: hit.x + HL, y: HW - hit.z };
  }

  /** Toạ độ màn hình (px) của một điểm trên bàn. */
  project(x: number, y: number, h = 0): { x: number; y: number } {
    const v = toWorld(x, y, h).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  pocketScreen(i: number): { x: number; y: number } {
    const p = POCKETS[i];
    const v = new THREE.Vector3(p.cx, RH, -p.cy).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  render(dt: number): void {
    this.clock += dt;
    let anim = false;

    for (let id = 0; id < 16; id++) {
      const s = this.sink[id];
      if (!s) continue;
      anim = true;
      s.t += dt;
      const k = Math.min(1, s.t / 0.4);
      const p = POCKETS[s.pocket];
      const m = this.balls[id];
      const e = Math.min(1, k * 1.6);
      m.position.set(s.from.x + (p.cx - s.from.x) * e, R - k * k * 0.13, s.from.z + (-p.cy - s.from.z) * e);
      this.shadows[id].visible = k < 0.3;
      this.shadows[id].position.set(m.position.x, 0.0015, m.position.z);
      if (k >= 1) { m.visible = false; this.sink[id] = null; }
    }

    if (this.transition) {
      anim = true;
      const tr = this.transition;
      tr.t = Math.min(1, tr.t + dt / tr.dur);
      const e = 1 - Math.pow(1 - tr.t, 3);
      this.camera.position.lerpVectors(tr.fromPos, tr.toPos, e);
      this.controls.target.lerpVectors(tr.fromTarget, tr.toTarget, e);
      if (tr.t >= 1) this.transition = null;
    }

    let camMoved = false;
    if (this.mode === 'cue') {
      // Camera gắn CHẶT phía sau cơ (xoay cơ là camera quay đúng theo cung tròn quanh bi, không trễ/giật).
      // Chỉ khi vừa chuyển sang góc này mới chuyển mượt từ vị trí camera cũ trong ~0.45 s.
      const back = TMP_A.copy(this.cueBall).addScaledVector(this.cueDir, -0.72);
      back.y += 0.22;
      const look = TMP_B.copy(this.cueBall).addScaledVector(this.cueDir, 0.9);
      look.y = 0;
      TMP_C.copy(this.camera.position);
      if (this.cueBlend < 1) {
        this.cueBlend = Math.min(1, this.cueBlend + dt / 0.45);
        const e = 1 - Math.pow(1 - this.cueBlend, 3);
        this.camera.position.lerpVectors(this.blendFromPos, back, e);
        this.controls.target.lerpVectors(this.blendFromTarget, look, e);
      } else {
        this.camera.position.copy(back);
        this.controls.target.copy(look);
      }
      this.camera.lookAt(this.controls.target);
      camMoved = TMP_C.distanceToSquared(this.camera.position) > 1e-12 || this.cueBlend < 1;
    } else {
      camMoved = this.controls.update();
    }

    // đèn treo chỉ hiện khi camera thấp hơn đèn (không che khi nhìn từ trên)
    const lampOn = this.camera.position.y < LAMP_Y - 0.15;
    if (this.lamp.visible !== lampOn) { this.lamp.visible = lampOn; this.dirty = true; }

    if (this.ringOn) {
      anim = true;
      const pulse = 0.6 + 0.35 * Math.sin(this.clock * 6);
      for (const r of this.pocketRings) (r.material as THREE.MeshBasicMaterial).opacity = pulse;
    }

    if (this.dirty || camMoved || anim) this.lastActive = this.clock;
    else if (this.pendingPr !== null && this.clock - this.lastActive > 0.6) this.applyPixelRatio(this.pendingPr);
    if (!(this.dirty || camMoved || anim)) { this.renderedLast = false; return; }
    this.adaptResolution(dt);
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
    this.renderedLast = true;
  }

  /** Độ phân giải động: máy yếu thì giảm dần số điểm ảnh thay vì tắt hiệu ứng. */
  private adaptResolution(dt: number): void {
    if (!this.renderedLast || dt <= 0 || dt > 0.12) return;
    if (this.warmup > 0) { this.warmup -= dt; return; }
    this.frameEma += (dt * 1000 - this.frameEma) * 0.08;
    this.adaptTimer += dt;
    if (this.adaptTimer < 1) return;
    this.adaptTimer = 0;
    let next = this.pr;
    if (this.frameEma > 21 && this.pr > 0.6) {
      // máy đang chậm: hạ độ phân giải
      next = Math.max(0.6, this.pr - 0.15);
      this.goodTime = 0;
      if (this.clock - this.lastRaise < 8) this.raiseWait = Math.min(64, this.raiseWait * 2); // vừa nâng đã chậm -> chờ lâu hơn
    } else if (this.frameEma < 17.8) {
      // chạy mượt (~60 FPS) đủ lâu thì nâng dần lại, để chậm tạm thời không làm hình mờ mãi
      this.goodTime += 1;
      if (this.goodTime >= this.raiseWait && this.pr < this.prMax) {
        next = Math.min(this.prMax, this.pr + 0.1);
        this.goodTime = 0;
        this.lastRaise = this.clock;
      }
    } else this.goodTime = 0;
    if (next !== this.pr) {
      // hạ thì áp dụng ngay (máy đang quá tải), nâng thì đợi lúc màn hình đứng yên
      if (next < this.pr) this.applyPixelRatio(next);
      else this.pendingPr = next;
    }
  }

  private applyPixelRatio(pr: number): void {
    this.pr = pr;
    this.pendingPr = null;
    this.renderer.setPixelRatio(pr);
    this.resize();
  }

  get pixelRatio(): number {
    return this.pr;
  }
}
