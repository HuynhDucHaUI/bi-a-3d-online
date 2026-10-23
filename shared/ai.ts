// Máy chơi cho chế độ luyện tập 1 người.
// Máy tìm các cặp (bi mục tiêu, lỗ) theo hình học, đánh thử từng cú trên đúng engine vật lý + luật dùng chung,
// chấm điểm kết quả (vào bi, giữ lượt, vị trí bi cái cho cú sau, phòng thủ) rồi đánh cú tốt nhất kèm sai số tay
// theo cấp độ.
import { BALL_R, FOOT_SPOT_X, G, HEAD_STRING_X, MAX_SHOT_SPEED, MU_ROLL, TABLE_L, TABLE_W } from './constants';
import { Choice, Game, GameView, groupOf, InHand, Seat, ShotInput, ShotOutcome, validCuePos } from './game';
import { BallPos, POCKET_CENTERS, ShotParams, Sim } from './physics';

export type AiLevel = 'easy' | 'medium' | 'hard' | 'pro';
export const AI_LEVELS: AiLevel[] = ['easy', 'medium', 'hard', 'pro'];
export const AI_LEVEL_NAME: Record<AiLevel, string> = { easy: 'Dễ', medium: 'Vừa', hard: 'Khó', pro: 'Cơ thủ chuyên nghiệp' };

interface Spin { x: number; y: number }

interface LevelCfg {
  /** sai số tay: độ lệch chuẩn của góc (rad), lực (tỉ lệ tốc độ) và điểm đánh */
  angleErr: number;
  powerErr: number;
  spinErr: number;
  /** số cú (bi + lỗ) tốt nhất theo hình học được đánh thử (lực vừa, giữa bi); 0 = không đánh thử, chọn theo hình học */
  tries: number;
  /** số cú tốt nhất sau lượt thử đầu được thử kỹ với mọi tổ hợp lực × điểm đánh bên dưới */
  refine: number;
  /** hệ số tốc độ bi cái được thử kỹ */
  speeds: number[];
  /** các điểm đánh được thử kỹ */
  spins: Spin[];
  /** bù "throw" (bi mục tiêu bị ma sát kéo lệch) bằng cách dò lại góc ngắm */
  solveThrow: boolean;
  /** trọng số chơi vị trí bi cái cho cú sau / phòng thủ (để lại thế khó cho đối thủ) */
  position: number;
  safety: number;
  /** cú phòng thủ: điểm chạm (tỉ lệ độ dày) và lực được thử; rỗng = không đánh phòng thủ */
  safetyHits: number[];
  safetyPowers: number[];
  /** xét cú phòng thủ khi điểm cú tấn công tốt nhất dưới ngưỡng này (0 = chỉ khi không cú nào giữ được lượt) */
  safetyBelow: number;
  /** đánh thử lại vài cú tốt nhất với sai số tay của mình để ưu tiên cú chắc ăn */
  robustTop: number;
  robustRuns: number;
  /** cầm bi cái: > 0 = chỉ thử vài chỗ ngẫu nhiên, 0 = đặt bi ngay sau bi mục tiêu cho từng cú */
  randomPlacements: number;
}

const C: Spin = { x: 0, y: 0 };

const LEVELS: Record<AiLevel, LevelCfg> = {
  easy: {
    angleErr: 0.03, powerErr: 0.18, spinErr: 0, tries: 0, refine: 0, speeds: [1.15], spins: [C], solveThrow: false,
    position: 0, safety: 0, safetyHits: [], safetyPowers: [], safetyBelow: 0, robustTop: 0, robustRuns: 0, randomPlacements: 6,
  },
  medium: {
    angleErr: 0.011, powerErr: 0.09, spinErr: 0, tries: 6, refine: 2, speeds: [0.9, 1.35], spins: [C], solveThrow: false,
    position: 0, safety: 0, safetyHits: [0], safetyPowers: [0.35, 0.5], safetyBelow: 0, robustTop: 0, robustRuns: 0, randomPlacements: 0,
  },
  hard: {
    angleErr: 0.0045, powerErr: 0.05, spinErr: 0.04, tries: 8, refine: 3, speeds: [0.85, 1.15, 1.5],
    spins: [C, { x: 0, y: -0.5 }, { x: 0, y: 0.45 }], solveThrow: true,
    position: 0.8, safety: 0.8, safetyHits: [0, 0.6, -0.6], safetyPowers: [0.3, 0.5], safetyBelow: 60,
    robustTop: 3, robustRuns: 4, randomPlacements: 0,
  },
  pro: {
    angleErr: 0.0016, powerErr: 0.025, spinErr: 0.02, tries: 10, refine: 4, speeds: [0.8, 1.05, 1.4, 1.9],
    spins: [C, { x: 0, y: -0.4 }, { x: 0, y: -0.85 }, { x: 0, y: 0.5 }, { x: 0.45, y: 0 }, { x: -0.45, y: 0 }], solveThrow: true,
    position: 1.5, safety: 1.2, safetyHits: [0, 0.5, -0.5, 0.85, -0.85], safetyPowers: [0.25, 0.4, 0.6], safetyBelow: 120,
    robustTop: 5, robustRuns: 6, randomPlacements: 0,
  },
};

export interface PlanOptions {
  rng?: () => number;
  /** gọi xen giữa các lần đánh thử để không chiếm trọn luồng xử lý của server */
  pause?: () => Promise<void>;
}

type Vec = { x: number; y: number };

/** Một cú vào bi tính theo hình học. */
interface Cand {
  cue: Vec;
  target: number;
  pocket: number;
  /** hướng đánh bi cái (tới vị trí bi ma) */
  dir: Vec;
  /** hướng bi mục tiêu cần đi (tới lỗ) */
  want: Vec;
  ease: number;
  d1: number;
  d2: number;
  cut: number;
}

interface Scored { input: ShotInput; score: number; robust?: number }

const other = (s: Seat): Seat => (s === 0 ? 1 : 0);
const norm = (x: number, y: number): Vec => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Điểm ngắm của từng lỗ: hơi lùi vào trong miệng lỗ góc, sâu xuống dưới vạch băng ở lỗ giữa. */
const POCKET_AIM: Vec[] = POCKET_CENTERS.map((p, i) => i < 4
  ? { x: p.x + (p.x === 0 ? 0.025 : -0.025), y: p.y + (p.y === 0 ? 0.025 : -0.025) }
  : { x: p.x, y: p.y + (p.y === 0 ? -0.01 : 0.01) });

function gauss(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return clamp(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()), -3, 3);
}

/** Các bi người chơi được phép chạm trước. */
export function legalTargets(v: GameView, seat: Seat): number[] {
  const live = v.balls.filter((b) => !b.pocketed && b.id !== 0);
  const g = v.groups[seat];
  if (!g) return live.filter((b) => b.id !== 8).map((b) => b.id);
  const own = live.filter((b) => groupOf(b.id) === g).map((b) => b.id);
  return own.length ? own : [8];
}

/** Đoạn a→b có bị bi nào (trừ các bi bỏ qua) chắn trong khoảng cách clear không. */
function pathClear(balls: BallPos[], a: Vec, b: Vec, skip: number[], clear = 2 * BALL_R): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1e-9;
  for (const o of balls) {
    if (o.pocketed || skip.includes(o.id)) continue;
    const t = clamp(((o.x - a.x) * dx + (o.y - a.y) * dy) / l2, 0, 1);
    const px = a.x + dx * t - o.x, py = a.y + dy * t - o.y;
    if (px * px + py * py < (clear - 1e-4) ** 2) return false;
  }
  return true;
}

/** Độ dễ của cú (0..1): cắt mỏng và đường xa thì khó; lỗ giữa không nhận bi đi quá chéo. */
function easeOf(cut: number, d1: number, d2: number, pocket: number, want: Vec): number {
  if (cut < 0.25) return 0;
  let e = cut * cut * Math.exp(-0.55 * d1 - 0.85 * d2);
  if (pocket >= 4) e *= clamp((Math.abs(want.y) - 0.5) / 0.4, 0, 1);
  return e;
}

function candidatesFrom(balls: BallPos[], cue: Vec, targets: number[]): Cand[] {
  const out: Cand[] = [];
  for (const id of targets) {
    const t = balls[id];
    if (!t || t.pocketed) continue;
    POCKET_AIM.forEach((pk, i) => {
      const c = shotTo(balls, cue, t, i, pk);
      if (c) out.push(c);
    });
  }
  return out;
}

function shotTo(balls: BallPos[], cue: Vec, t: BallPos, pocket: number, pk: Vec = POCKET_AIM[pocket]): Cand | null {
  const want = norm(pk.x - t.x, pk.y - t.y);
  const ghost = { x: t.x - want.x * 2 * BALL_R, y: t.y - want.y * 2 * BALL_R };
  const dir = norm(ghost.x - cue.x, ghost.y - cue.y);
  const cut = dir.x * want.x + dir.y * want.y;
  const d1 = Math.hypot(ghost.x - cue.x, ghost.y - cue.y);
  const d2 = Math.hypot(pk.x - t.x, pk.y - t.y);
  const ease = easeOf(cut, d1, d2, pocket, want);
  if (ease <= 0) return null;
  if (!pathClear(balls, cue, ghost, [0, t.id]) || !pathClear(balls, t, pk, [0, t.id])) return null;
  return { cue, target: t.id, pocket, dir, want, ease, d1, d2, cut };
}

/** Độ dễ của lượt kế tiếp với bàn bi này (cú dễ nhất + một phần cú dễ thứ hai ở bi khác). */
function nextQuality(v: GameView, seat: Seat): number {
  if (v.inHand !== 'none') return 1;
  const cs = candidatesFrom(v.balls, v.balls[0], legalTargets(v, seat)).sort((a, b) => b.ease - a.ease);
  if (!cs.length) return 0;
  const second = cs.find((c) => c.target !== cs[0].target);
  return cs[0].ease + 0.35 * (second?.ease ?? 0);
}

/** Lực (0..1) để bi mục tiêu tới lỗ còn đủ đà, nhân thêm hệ số tốc độ. */
function powerFor(c: Cand, speedMul: number): number {
  const roll = MU_ROLL * G;
  const vt = 1.4 * Math.sqrt(0.16 + 2 * roll * 1.1 * c.d2);
  const vc = vt / (0.975 * Math.max(c.cut, 0.3));
  const v0 = 1.4 * Math.sqrt(vc * vc + 2 * roll * c.d1) * speedMul;
  return clamp(Math.pow(Math.min(v0, MAX_SHOT_SPEED) / MAX_SHOT_SPEED, 2 / 3), 0.1, 1);
}

/** Hướng bi mục tiêu bay đi ngay khi bị chạm (null nếu bi cái chạm bi khác trước hoặc không chạm). */
function launchDir(balls: BallPos[], params: ShotParams, target: number): Vec | null {
  const sim = new Sim(balls);
  sim.applyShot(params);
  while (sim.time < 4 && sim.moving) {
    sim.step();
    if (sim.cue.pocketed) return null;
    for (const b of sim.balls) {
      if (b.id === 0 || b.pocketed || (b.vx === 0 && b.vy === 0)) continue;
      return b.id === target ? norm(b.vx, b.vy) : null;
    }
  }
  return null;
}

/** Dò góc ngắm (phương pháp cát tuyến) để bi mục tiêu đi đúng hướng `want` kể cả khi bị throw. */
function solveAim(balls: BallPos[], c: Cand, base: ShotParams): ShotParams {
  const wantA = Math.atan2(c.want.y, c.want.x);
  const at = (a: number): ShotParams => ({ ...base, dx: Math.cos(a), dy: Math.sin(a) });
  const err = (a: number): number | null => {
    const d = launchDir(balls, at(a), c.target);
    return d ? wrap(Math.atan2(d.y, d.x) - wantA) : null;
  };
  let a0 = Math.atan2(base.dy, base.dx);
  let e0 = err(a0);
  if (e0 === null) return base;
  let best = { a: a0, e: Math.abs(e0) };
  let a1 = a0 + 0.0005;
  for (let i = 0; i < 6 && best.e > 0.0003; i++) {
    const e1 = err(a1);
    if (e1 === null) break;
    if (Math.abs(e1) < best.e) best = { a: a1, e: Math.abs(e1) };
    const slope = (e1 - e0) / (a1 - a0);
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-6) break;
    const a2 = a1 - e1 / slope;
    if (Math.abs(a2 - a1) > 0.05) break;
    a0 = a1; e0 = e1; a1 = a2;
  }
  return at(best.a);
}

function scoreOutcome(out: ShotOutcome, me: Seat, cfg: LevelCfg): number {
  const r = out.view;
  if (r.phase === 'over') return r.winner === me ? 1000 : -1000;
  if (out.foul) return -300;
  if (r.turn === me) return 200 + cfg.position * 100 * nextQuality(r, me);
  return -100 - cfg.safety * 100 * nextQuality(r, other(me));
}

function evaluate(v: GameView, me: Seat, input: ShotInput, cfg: LevelCfg): number {
  try {
    return scoreOutcome(Game.fromView(v).shoot(me, input), me, cfg);
  } catch {
    return -Infinity;
  }
}

function withError(p: ShotParams, cfg: LevelCfg, rng: () => number): ShotParams {
  const a = Math.atan2(p.dy, p.dx) + gauss(rng) * cfg.angleErr;
  // sai số lực tính theo tốc độ bi cái (lực = tốc độ^(2/3))
  const power = clamp(p.power * Math.pow(Math.max(0.2, 1 + gauss(rng) * cfg.powerErr), 2 / 3), 0.05, 1);
  return {
    dx: Math.cos(a), dy: Math.sin(a), power,
    spinX: clamp(p.spinX + gauss(rng) * cfg.spinErr, -1, 1), spinY: clamp(p.spinY + gauss(rng) * cfg.spinErr, -1, 1),
  };
}

function randomSpot(balls: BallPos[], mode: InHand, rng: () => number): Vec | null {
  const maxX = mode === 'kitchen' ? HEAD_STRING_X : TABLE_L - 0.05;
  for (let i = 0; i < 300; i++) {
    const p = { x: 0.05 + rng() * (maxX - 0.05), y: 0.05 + rng() * (TABLE_W - 0.1) };
    if (validCuePos(balls, p, mode)) return p;
  }
  return null;
}

/** Vị trí đặt bi cái khi được cầm bi: ngay sau bi mục tiêu theo đường tới lỗ (lệch vài góc để có vị trí). */
function placements(v: GameView, targets: number[], cfg: LevelCfg, rng: () => number): Vec[] {
  const out: Vec[] = [];
  if (cfg.randomPlacements > 0) {
    for (let i = 0; i < cfg.randomPlacements; i++) { const p = randomSpot(v.balls, v.inHand, rng); if (p) out.push(p); }
    return out;
  }
  for (const id of targets) {
    const t = v.balls[id];
    POCKET_AIM.forEach((pk) => {
      const want = norm(pk.x - t.x, pk.y - t.y);
      const ghost = { x: t.x - want.x * 2 * BALL_R, y: t.y - want.y * 2 * BALL_R };
      for (const s of [0.18, 0.32, 0.5]) {
        for (const off of [0, 0.3, -0.3]) {
          const c = Math.cos(off), sn = Math.sin(off);
          const p = { x: ghost.x - (want.x * c - want.y * sn) * s, y: ghost.y - (want.x * sn + want.y * c) * s };
          if (validCuePos(v.balls, p, v.inHand)) out.push(p);
        }
      }
    });
  }
  return out;
}

/** Cú phòng thủ / cú băng: chạm một bi hợp lệ với độ dày và lực khác nhau, để lại thế khó cho đối thủ. */
function safetyInputs(v: GameView, cue: Vec, targets: number[], cfg: LevelCfg, cuePos?: Vec): ShotInput[] {
  const out: ShotInput[] = [];
  const near = targets.map((id) => v.balls[id]).sort((a, b) => Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y)).slice(0, 5);
  const add = (aim: Vec, power: number) => {
    const d = norm(aim.x - cue.x, aim.y - cue.y);
    out.push({ params: { dx: d.x, dy: d.y, power, spinX: 0, spinY: 0 }, cuePos });
  };
  let direct = false;
  for (const t of near) {
    if (!pathClear(v.balls, cue, t, [0, t.id])) continue;
    direct = true;
    const d = norm(t.x - cue.x, t.y - cue.y);
    for (const f of cfg.safetyHits) {
      const aim = { x: t.x - d.y * f * 2 * BALL_R, y: t.y + d.x * f * 2 * BALL_R };
      for (const p of cfg.safetyPowers) add(aim, p);
    }
  }
  if (!direct) {
    // không có đường thẳng tới bi nào: đánh một băng (ngắm vào ảnh đối xứng của bi qua băng)
    for (const t of near) {
      const mirrors = [{ x: 2 * BALL_R - t.x, y: t.y }, { x: 2 * (TABLE_L - BALL_R) - t.x, y: t.y }, { x: t.x, y: 2 * BALL_R - t.y }, { x: t.x, y: 2 * (TABLE_W - BALL_R) - t.y }];
      for (const m of mirrors) for (const p of [0.45, 0.65]) add(m, p);
    }
  }
  return out;
}

/** Cú phá bi: đặt bi cái giữa vạch, đánh thẳng vào bi đầu. */
function breakShot(cfg: LevelCfg, level: AiLevel, rng: () => number): ShotInput {
  const cuePos = { x: HEAD_STRING_X - 0.01, y: TABLE_W / 2 };
  const params: ShotParams = {
    dx: FOOT_SPOT_X - cuePos.x, dy: 0, power: level === 'easy' ? 0.85 : level === 'medium' ? 0.95 : 1,
    spinX: 0, spinY: level === 'hard' || level === 'pro' ? -0.2 : 0,
  };
  return { params: withError(params, cfg, rng), cuePos };
}

/** Không tìm được cú nào: đánh nhẹ vào bi hợp lệ gần nhất. */
function fallbackShot(v: GameView, me: Seat, rng: () => number): ShotInput {
  const cuePos = v.inHand !== 'none' ? (validCuePos(v.balls, v.balls[0], v.inHand) ? undefined : randomSpot(v.balls, v.inHand, rng) ?? undefined) : undefined;
  const cue = cuePos ?? v.balls[0];
  const targets = legalTargets(v, me).map((id) => v.balls[id]);
  targets.sort((a, b) => Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y));
  const t = targets[0] ?? { x: TABLE_L / 2, y: TABLE_W / 2 };
  const d = norm(t.x - cue.x, t.y - cue.y);
  const input: ShotInput = { params: { dx: d.x, dy: d.y, power: 0.45, spinX: 0, spinY: 0 }, cuePos };
  if (v.phase === 'play' && legalTargets(v, me)[0] === 8 && v.groups[me]) input.calledPocket = nearestPocket(v.balls[8]);
  return input;
}

function nearestPocket(b: Vec): number {
  let best = 0;
  POCKET_CENTERS.forEach((p, i) => { if (Math.hypot(p.x - b.x, p.y - b.y) < Math.hypot(POCKET_CENTERS[best].x - b.x, POCKET_CENTERS[best].y - b.y)) best = i; });
  return best;
}

/** Máy chọn khi đối thủ phá bi lỗi: luôn nhận bàn. */
export function planChoice(): Choice {
  return 'accept';
}

/** Chọn cú đánh cho máy ở cấp độ `level`. Kết quả đã cộng sai số tay. */
export async function planShot(v: GameView, me: Seat, level: AiLevel, opt: PlanOptions = {}): Promise<ShotInput> {
  const rng = opt.rng ?? Math.random;
  const cfg = LEVELS[level];
  if (v.phase === 'break') return breakShot(cfg, level, rng);

  const targets = legalTargets(v, me);
  const needsCall = !!v.groups[me] && targets[0] === 8;
  const inHand = v.inHand !== 'none';
  const finish = (input: ShotInput, pocket?: number): ShotInput => {
    const out: ShotInput = { params: withError(input.params, cfg, rng), cuePos: input.cuePos };
    if (needsCall) out.calledPocket = input.calledPocket ?? pocket ?? nearestPocket(v.balls[8]);
    return out;
  };

  // các cú vào bi theo hình học
  let cands: Cand[] = [];
  if (inHand) {
    for (const p of placements(v, targets, cfg, rng)) cands.push(...candidatesFrom(v.balls, p, targets));
  } else cands = candidatesFrom(v.balls, v.balls[0], targets);
  cands.sort((a, b) => b.ease - a.ease);
  // mỗi cặp (bi, lỗ) giữ tối đa 2 vị trí bi cái để danh sách thử đủ đa dạng
  const seen = new Map<string, number>();
  cands = cands.filter((c) => { const k = `${c.target}:${c.pocket}`; const n = seen.get(k) ?? 0; seen.set(k, n + 1); return n < 2; });

  const inputOf = (c: Cand, params: ShotParams): ShotInput => ({ params, cuePos: inHand ? c.cue : undefined, calledPocket: needsCall ? c.pocket : undefined });

  // Dễ: không đánh thử, chọn một trong vài cú dễ nhất
  if (cfg.tries === 0) {
    if (!cands.length) return finish(fallbackShot(v, me, rng));
    const r = rng();
    const c = cands[Math.min(cands.length - 1, r < 0.6 ? 0 : r < 0.85 ? 1 : 2)];
    return finish(inputOf(c, { dx: c.dir.x, dy: c.dir.y, power: powerFor(c, cfg.speeds[0]), spinX: 0, spinY: 0 }));
  }

  let sims = 0;
  const tick = async () => { if (opt.pause && ++sims % 6 === 0) await opt.pause(); };
  const tryShot = async (c: Cand, speed: number, sp: Spin): Promise<Scored> => {
    const balls = inHand ? v.balls.map((b) => (b.id === 0 ? { ...b, x: c.cue.x, y: c.cue.y, pocketed: false } : b)) : v.balls;
    let params: ShotParams = { dx: c.dir.x, dy: c.dir.y, power: powerFor(c, speed), spinX: sp.x, spinY: sp.y };
    if (cfg.solveThrow) params = solveAim(balls, c, params);
    const input = inputOf(c, params);
    const s = { input, score: evaluate(v, me, input, cfg) };
    await tick();
    return s;
  };
  /** đánh thử lại với sai số tay của mình: cú chắc ăn hơn cú "đẹp nhưng khó" */
  const robust = async (list: Scored[]): Promise<void> => {
    for (const s of list.slice(0, cfg.robustTop)) {
      let sum = 0;
      for (let i = 0; i < cfg.robustRuns; i++) {
        sum += Math.max(-1000, evaluate(v, me, { ...s.input, params: withError(s.input.params, cfg, rng) }, cfg));
        await tick();
      }
      s.robust = 0.3 * s.score + 0.7 * (sum / cfg.robustRuns);
    }
  };
  const value = (s: Scored): number => s.robust ?? s.score;
  const byValue = (a: Scored, b: Scored): number => (b.robust ?? -Infinity) - (a.robust ?? -Infinity) || b.score - a.score;

  // lượt 1: thử thô mỗi cú (lực vừa, giữa bi); lượt 2: thử kỹ vài cú tốt nhất với mọi lực × điểm đánh
  const coarse: { c: Cand; s: Scored }[] = [];
  for (const c of cands.slice(0, cfg.tries)) coarse.push({ c, s: await tryShot(c, 1.1, C) });
  coarse.sort((a, b) => b.s.score - a.s.score);
  const scored: Scored[] = coarse.map((x) => x.s);
  for (const { c } of coarse.slice(0, cfg.refine)) {
    for (const sp of cfg.spins) for (const k of cfg.speeds) scored.push(await tryShot(c, k, sp));
  }
  scored.sort((a, b) => b.score - a.score);
  if (cfg.robustRuns > 0) { await robust(scored); scored.sort(byValue); }

  if (cfg.safetyHits.length && (!scored.length || value(scored[0]) < cfg.safetyBelow)) {
    const cuePos = inHand ? cands[0]?.cue ?? (validCuePos(v.balls, v.balls[0], v.inHand) ? undefined : randomSpot(v.balls, v.inHand, rng) ?? undefined) : undefined;
    const cue = cuePos ?? v.balls[0];
    const placed = cuePos ? v.balls.map((b) => (b.id === 0 ? { ...b, x: cuePos.x, y: cuePos.y } : b)) : v.balls;
    const safe: Scored[] = [];
    for (const input of safetyInputs({ ...v, balls: placed }, cue, targets, cfg, cuePos)) {
      if (needsCall) input.calledPocket = nearestPocket(v.balls[8]);
      safe.push({ input, score: evaluate(v, me, input, cfg) });
      await tick();
    }
    safe.sort((a, b) => b.score - a.score);
    if (cfg.robustRuns > 0) await robust(safe.slice(0, 2));
    scored.push(...safe);
    scored.sort(cfg.robustRuns > 0 ? byValue : (a, b) => b.score - a.score);
  }

  if (!scored.length || scored[0].score === -Infinity) return finish(fallbackShot(v, me, rng));
  return finish(scored[0].input);
}
