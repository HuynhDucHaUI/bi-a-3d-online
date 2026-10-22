// Engine vật lý 2D cho mặt bàn bi-a, có xoáy (trượt / lăn / xoáy ngang).
// Chỉ dùng + - * / và sqrt để cho kết quả giống nhau giữa các máy.
import {
  BALL_E, BALL_MU_A, BALL_MU_B, BALL_MU_C, BALL_R, CORNER_MOUTH, CUSHION_COS, CUSHION_E, CUSHION_E_MIN, CUSHION_E_SLOPE,
  CUSHION_MU_0, CUSHION_MU_MIN, CUSHION_MU_SLOPE, CUSHION_SIN, DT, G, KNUCKLE_R, MAX_SHOT_SPEED,
  MAX_SIM_TIME, MU_ROLL, MU_SLIDE, SIDE_CAPTURE_Y, SIDE_MOUTH, SPIN_DECEL, STOP_SPEED, TABLE_L, TABLE_W,
} from './constants';

export interface Ball {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  wx: number; // vận tốc góc quanh trục x, y (lăn) và z (xoáy ngang)
  wy: number;
  wz: number;
  pocketed: boolean;
}

export interface BallPos {
  id: number;
  x: number;
  y: number;
  pocketed: boolean;
}

export interface ShotParams {
  dx: number; // hướng đánh (vector, sẽ được chuẩn hoá)
  dy: number;
  power: number; // 0..1
  spinX: number; // -1..1, dương = đánh bên phải tâm bi
  spinY: number; // -1..1, dương = đánh phía trên tâm bi (đuổi), âm = giật
}

export type SimEvent =
  | { t: number; type: 'ball'; a: number; b: number; speed: number }
  | { t: number; type: 'cushion'; ball: number; speed: number }
  | { t: number; type: 'pocket'; ball: number; pocket: number };

/** Tâm 6 lỗ theo thứ tự: 0 góc trái-dưới, 1 góc phải-dưới, 2 góc trái-trên, 3 góc phải-trên, 4 giữa-dưới, 5 giữa-trên */
export const POCKET_CENTERS: { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: TABLE_L, y: 0 },
  { x: 0, y: TABLE_W },
  { x: TABLE_L, y: TABLE_W },
  { x: TABLE_L / 2, y: 0 },
  { x: TABLE_L / 2, y: TABLE_W },
];

const KNUCKLES: { x: number; y: number }[] = (() => {
  const L = TABLE_L, W = TABLE_W, M = CORNER_MOUTH, S = SIDE_MOUTH;
  return [
    { x: M, y: 0 }, { x: 0, y: M },
    { x: L - M, y: 0 }, { x: L, y: M },
    { x: M, y: W }, { x: 0, y: W - M },
    { x: L - M, y: W }, { x: L, y: W - M },
    { x: L / 2 - S, y: 0 }, { x: L / 2 + S, y: 0 },
    { x: L / 2 - S, y: W }, { x: L / 2 + S, y: W },
  ];
})();

const INV_I = 5 / (2 * BALL_R); // 1 / (I/m) * R ... dùng cho gia tốc góc: alpha = (5 / (2R)) * a_ma_sat
const MIN_EVENT_SPEED = 0.02;

export function makeBall(p: BallPos): Ball {
  return { id: p.id, x: p.x, y: p.y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, pocketed: p.pocketed };
}

export class Sim {
  balls: Ball[];
  time = 0;
  events: SimEvent[] = [];

  constructor(positions: BallPos[]) {
    this.balls = positions.map(makeBall);
  }

  get cue(): Ball {
    return this.balls[0];
  }

  /** Truyền xung lượng từ đầu cơ vào bi cái. */
  applyShot(shot: ShotParams): void {
    const len = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy) || 1;
    const dx = shot.dx / len;
    const dy = shot.dy / len;
    // lực theo đường cong p^1.5: dải lực nhẹ/vừa (dùng nhiều nhất) được chia mịn hơn, 100% vẫn đủ phá bi
    const p = clamp(shot.power, 0, 1);
    const v0 = p * Math.sqrt(p) * MAX_SHOT_SPEED;
    let a = shot.spinX;
    let b = shot.spinY;
    const m = Math.sqrt(a * a + b * b);
    if (m > 1) { a /= m; b /= m; }
    const c = this.cue;
    c.vx = dx * v0;
    c.vy = dy * v0;
    const top = (1.25 * v0 * b) / BALL_R; // xoáy dọc: dương = đuổi
    c.wx = -dy * top;
    c.wy = dx * top;
    c.wz = (1.25 * v0 * a) / BALL_R; // xoáy ngang
  }

  get moving(): boolean {
    for (const b of this.balls) {
      if (!b.pocketed && (b.vx !== 0 || b.vy !== 0 || b.wx !== 0 || b.wy !== 0)) return true;
    }
    return false;
  }

  /** Chạy đến khi mọi bi dừng hẳn (hoặc hết thời gian tối đa). */
  run(maxTime = MAX_SIM_TIME): void {
    while (this.moving && this.time < maxTime) this.step(DT);
    for (const b of this.balls) { b.wz = 0; b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; }
  }

  snapshot(): BallPos[] {
    return this.balls.map((b) => ({ id: b.id, x: b.x, y: b.y, pocketed: b.pocketed }));
  }

  step(dt: number = DT): void {
    const balls = this.balls;
    // Bi đứng yên (không tịnh tiến, không lăn) không thể tự va chạm/rơi lỗ: bỏ qua để mô phỏng nhẹ hơn nhiều
    // (phần lớn thời gian chỉ vài bi đang chạy).
    for (const b of balls) if (!b.pocketed && !(still(b) && b.wz === 0)) integrate(b, dt);
    this.time += dt;

    for (const b of balls) if (!b.pocketed && !still(b)) this.checkPocket(b);

    const n = balls.length;
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (a.pocketed) continue;
      const aStill = still(a);
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (b.pocketed || (aStill && still(b))) continue;
        this.ballCollide(a, b);
      }
    }

    for (const b of balls) {
      if (b.pocketed || still(b)) continue;
      this.knuckleCollide(b);
      this.wallCollide(b);
      this.checkPocket(b);
    }
  }

  private checkPocket(b: Ball): void {
    const { x, y } = b;
    const L = TABLE_L, W = TABLE_W;
    let pocket = -1;
    const dxc = Math.min(x, L - x);
    const dyc = Math.min(y, W - y);
    if (dxc + dyc < CORNER_MOUTH) {
      pocket = (x < L / 2 ? 0 : 1) + (y < W / 2 ? 0 : 2);
    } else if (dyc < SIDE_CAPTURE_Y && Math.abs(x - L / 2) < SIDE_MOUTH) {
      pocket = y < W / 2 ? 4 : 5;
    }
    if (pocket >= 0) {
      b.pocketed = true;
      b.vx = b.vy = b.wx = b.wy = b.wz = 0;
      this.events.push({ t: this.time, type: 'pocket', ball: b.id, pocket });
    }
  }

  private ballCollide(a: Ball, b: Ball): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d2 = dx * dx + dy * dy;
    const min = BALL_R * 2;
    if (d2 >= min * min) return;
    const d = Math.sqrt(d2) || 1e-9;
    const nx = dx / d;
    const ny = dy / d;
    // tách hai bi
    const push = (min - d) / 2;
    a.x -= nx * push; a.y -= ny * push;
    b.x += nx * push; b.y += ny * push;

    const tx = -ny;
    const ty = nx;
    // vận tốc điểm tiếp xúc (tính cả xoáy ngang): v + w x r, r1 = R*n, r2 = -R*n
    const c1x = a.vx - a.wz * BALL_R * ny;
    const c1y = a.vy + a.wz * BALL_R * nx;
    const c2x = b.vx + b.wz * BALL_R * ny;
    const c2y = b.vy - b.wz * BALL_R * nx;
    const rx = c1x - c2x;
    const ry = c1y - c2y;
    const vn = rx * nx + ry * ny;
    if (vn <= 0) return; // đang tách ra
    const vt = rx * tx + ry * ty;

    // xung lượng pháp tuyến (khối lượng đơn vị)
    const jn = ((1 + BALL_E) * vn) / 2;
    a.vx -= jn * nx; a.vy -= jn * ny;
    b.vx += jn * nx; b.vy += jn * ny;
    // ma sát tiếp tuyến: tạo "throw" và truyền xoáy ngang.
    // Hệ số ma sát phụ thuộc tốc độ trượt (thực nghiệm của Alciatore): trượt chậm -> ma sát lớn.
    const need = vt / 7;
    const mu = BALL_MU_A + BALL_MU_B * Math.exp(-BALL_MU_C * Math.abs(vt));
    const lim = mu * jn;
    const jt = -clamp(need, -lim, lim);
    a.vx += jt * tx; a.vy += jt * ty;
    b.vx -= jt * tx; b.vy -= jt * ty;
    const dw = (jt * BALL_R) / (0.4 * BALL_R * BALL_R); // I = 2/5 m R^2, m = 1
    a.wz += dw;
    b.wz += dw;

    if (vn > MIN_EVENT_SPEED) this.events.push({ t: this.time, type: 'ball', a: a.id, b: b.id, speed: vn });
  }

  private knuckleCollide(b: Ball): void {
    const r = BALL_R + KNUCKLE_R;
    for (const k of KNUCKLES) {
      const dx = b.x - k.x;
      const dy = b.y - k.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2) || 1e-9;
      const nx = dx / d;
      const ny = dy / d;
      b.x = k.x + nx * r;
      b.y = k.y + ny * r;
      this.cushionBounce(b, nx, ny);
    }
  }

  private wallCollide(b: Ball): void {
    const L = TABLE_L, W = TABLE_W, R = BALL_R;
    const inCornerX = b.x < CORNER_MOUTH || b.x > L - CORNER_MOUTH;
    const inSide = Math.abs(b.x - L / 2) < SIDE_MOUTH;
    if (!inCornerX && !inSide) {
      if (b.y < R) { b.y = R; this.cushionBounce(b, 0, 1); }
      else if (b.y > W - R) { b.y = W - R; this.cushionBounce(b, 0, -1); }
    }
    const inCornerY = b.y < CORNER_MOUTH || b.y > W - CORNER_MOUTH;
    if (!inCornerY) {
      if (b.x < R) { b.x = R; this.cushionBounce(b, 1, 0); }
      else if (b.x > L - R) { b.x = L - R; this.cushionBounce(b, -1, 0); }
    }
  }

  /**
   * Va chạm bi - băng theo mô hình Han (2005): mũi băng chạm bi ở phía trên tâm (63,5% đường kính),
   * nên băng vừa đẩy bi ra vừa "ăn" bớt xoáy lăn, xoáy ngang làm lệch góc bật đúng chiều.
   * n là pháp tuyến hướng vào trong bàn. Khối lượng đơn vị, I = 2/5 R^2.
   */
  private cushionBounce(b: Ball, nx: number, ny: number): void {
    const R = BALL_R;
    // hệ toạ độ cục bộ: x' hướng vào băng, y' = z × x' (dọc băng)
    const ax = -nx, ay = -ny;
    const bx = -ay, by = ax;
    const vx = b.vx * ax + b.vy * ay; // tốc độ lao vào băng
    if (vx <= 0) return;
    const vy = b.vx * bx + b.vy * by;
    const wx = b.wx * ax + b.wy * ay;
    const wy = b.wx * bx + b.wy * by;
    const wz = b.wz;
    const s = CUSHION_SIN, c = CUSHION_COS;
    const e = cushionRestitution(vx);

    // vận tốc trượt tại điểm chạm (Han 2005, pt. 14; bi không nảy lên: vz = 0)
    const sx = vx * s + R * wy;
    const sy = -vy - R * wz * c + R * wx * s;
    const pn = (1 + e) * vx * c; // xung lượng pháp tuyến tại điểm chạm
    const slip = Math.sqrt(sx * sx + sy * sy);
    // ma sát băng giảm khi bi đập chéo (thực nghiệm Mathavan 2010)
    const mu = clamp(CUSHION_MU_0 - CUSHION_MU_SLOPE * Math.atan2(Math.abs(vy), vx), CUSHION_MU_MIN, CUSHION_MU_0);
    let fx: number, fy: number; // xung lượng ma sát trong mặt phẳng tiếp xúc
    if (slip / 3.5 <= mu * pn) {
      // ma sát đủ lớn để điểm chạm hết trượt (dính)
      fx = -sx / 3.5;
      fy = sy / 3.5;
    } else {
      // trượt suốt va chạm: ma sát = mu * N, ngược chiều trượt
      fx = (-mu * pn * sx) / slip;
      fy = (mu * pn * sy) / slip;
    }
    const PX = fx * s - pn * c;
    const PY = fy;
    const PZ = -fx * c - pn * s;
    const k = R / (0.4 * R * R);
    const nvx = vx + PX;
    const nvy = vy + PY;
    const nwx = wx - k * PY * s;
    const nwy = wy + k * (PX * s - PZ * c);
    const nwz = wz + k * PY * c;

    b.vx = nvx * ax + nvy * bx;
    b.vy = nvx * ay + nvy * by;
    b.wx = nwx * ax + nwy * bx;
    b.wy = nwx * ay + nwy * by;
    b.wz = nwz;
    if (vx > MIN_EVENT_SPEED) this.events.push({ t: this.time, type: 'cushion', ball: b.id, speed: vx });
  }
}

const still = (b: Ball): boolean => b.vx === 0 && b.vy === 0 && b.wx === 0 && b.wy === 0;

/** Hệ số phục hồi của băng giảm dần khi bi lao vào nhanh hơn (cao su bị nén mạnh mất nhiều năng lượng hơn). */
function cushionRestitution(vn: number): number {
  return clamp(CUSHION_E - CUSHION_E_SLOPE * vn, CUSHION_E_MIN, CUSHION_E);
}

function integrate(b: Ball, dt: number): void {
  const R = BALL_R;
  // vận tốc tiếp xúc giữa bi và nỉ
  let ux = b.vx - R * b.wy;
  let uy = b.vy + R * b.wx;
  let um = Math.sqrt(ux * ux + uy * uy);
  let remaining = dt;

  if (um > 1e-3) {
    // đang trượt
    const ax = (-MU_SLIDE * G * ux) / um;
    const ay = (-MU_SLIDE * G * uy) / um;
    const tr = um / (3.5 * MU_SLIDE * G); // thời gian để chuyển sang lăn
    const tau = Math.min(dt, tr);
    b.vx += ax * tau;
    b.vy += ay * tau;
    b.wx += INV_I * ay * tau;
    b.wy -= INV_I * ax * tau;
    remaining = dt - tau;
    if (remaining > 0) {
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
    }
  }

  if (remaining > 0 || um <= 1e-3) {
    // lăn thuần tuý
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed < STOP_SPEED) {
      b.vx = b.vy = b.wx = b.wy = 0;
    } else {
      const ns = Math.max(0, speed - MU_ROLL * G * (remaining > 0 ? remaining : dt));
      const k = ns / speed;
      b.vx *= k;
      b.vy *= k;
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
      if (ns === 0) b.wx = b.wy = 0;
    }
  }

  if (b.wz !== 0) {
    const d = SPIN_DECEL * dt;
    b.wz = b.wz > d ? b.wz - d : b.wz < -d ? b.wz + d : 0;
  }

  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
