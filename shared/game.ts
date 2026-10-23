// Luật 8 bi (bi trơn / bi sọc) theo thông lệ quốc tế (WPA) và quản lý trạng thái ván đấu.
import {
  BALL_R, CORNER_MOUTH, FOOT_SPOT_X, HEAD_STRING_X, SIDE_CAPTURE_Y, SIDE_MOUTH, TABLE_L, TABLE_W,
} from './constants';
import { BallPos, ShotParams, Sim, SimEvent } from './physics';

export type Group = 'solids' | 'stripes';
export type Phase = 'break' | 'play' | 'choice' | 'over';
export type InHand = 'none' | 'kitchen' | 'anywhere';
export type Choice = 'accept' | 'rerack-self' | 'rerack-other';
export type Seat = 0 | 1;

export interface GameView {
  balls: BallPos[];
  turn: Seat;
  breaker: Seat;
  groups: [Group | null, Group | null];
  phase: Phase;
  inHand: InHand;
  winner: Seat | null;
  message: string;
  /** Người chơi đang phải đánh bi 8 (đã hết bi nhóm mình) */
  onEight: boolean;
  /** Tăng sau mỗi thay đổi trạng thái (cú đánh, lựa chọn, hết giờ...) */
  seq: number;
}

export interface ShotInput {
  params: ShotParams;
  cuePos?: { x: number; y: number };
  calledPocket?: number;
}

export interface ShotOutcome {
  player: Seat;
  start: BallPos[];
  params: ShotParams;
  events: SimEvent[];
  duration: number;
  foul: string | null;
  view: GameView;
}

export class RuleError extends Error {}

export function groupOf(id: number): Group | 'eight' | 'cue' {
  if (id === 0) return 'cue';
  if (id === 8) return 'eight';
  return id < 8 ? 'solids' : 'stripes';
}

const other = (s: Seat): Seat => (s === 0 ? 1 : 0);

export function rackBalls(rng: () => number = Math.random): BallPos[] {
  const shuffle = <T,>(a: T[]): T[] => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const solids = shuffle([1, 2, 3, 4, 5, 6, 7]);
  const stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
  const slots: number[] = new Array(15).fill(0);
  slots[4] = 8;
  const cornerA = rng() < 0.5;
  slots[10] = cornerA ? solids.pop()! : stripes.pop()!;
  slots[14] = cornerA ? stripes.pop()! : solids.pop()!;
  const rest = shuffle([...solids, ...stripes]);
  for (let i = 0; i < 15; i++) if (slots[i] === 0) slots[i] = rest.pop()!;

  const eps = 0.0001;
  const rowDx = Math.sqrt(3) * (BALL_R + eps);
  const balls: BallPos[] = [{ id: 0, x: HEAD_STRING_X, y: TABLE_W / 2, pocketed: false }];
  let k = 0;
  for (let r = 0; r < 5; r++) {
    for (let j = 0; j <= r; j++) {
      balls.push({ id: slots[k++], x: FOOT_SPOT_X + r * rowDx, y: TABLE_W / 2 + (j - r / 2) * (2 * BALL_R + 2 * eps), pocketed: false });
    }
  }
  balls.sort((a, b) => a.id - b.id);
  return balls;
}

/** Kiểm tra vị trí đặt bi cái. */
export function validCuePos(balls: BallPos[], p: { x: number; y: number }, mode: InHand): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  const m = BALL_R + 0.002;
  if (p.x < m || p.x > TABLE_L - m || p.y < m || p.y > TABLE_W - m) return false;
  if (mode === 'kitchen' && p.x > HEAD_STRING_X) return false;
  const dxc = Math.min(p.x, TABLE_L - p.x);
  const dyc = Math.min(p.y, TABLE_W - p.y);
  if (dxc + dyc < CORNER_MOUTH + BALL_R) return false;
  if (dyc < SIDE_CAPTURE_Y + BALL_R && Math.abs(p.x - TABLE_L / 2) < SIDE_MOUTH) return false;
  for (const b of balls) {
    if (b.id === 0 || b.pocketed) continue;
    const dx = b.x - p.x, dy = b.y - p.y;
    if (dx * dx + dy * dy < (2 * BALL_R + 0.001) ** 2) return false;
  }
  return true;
}

/** Tìm chỗ trống gần điểm mong muốn để đặt lại bi cái. */
function freeSpot(balls: BallPos[], mode: InHand): { x: number; y: number } {
  for (let i = 0; i < 400; i++) {
    const ang = i * 2.399963; // góc vàng
    const rad = 0.03 * Math.sqrt(i);
    const p = { x: HEAD_STRING_X - rad * Math.abs(Math.cos(ang)), y: TABLE_W / 2 + rad * Math.sin(ang) };
    if (validCuePos(balls, p, mode)) return p;
  }
  return { x: HEAD_STRING_X, y: TABLE_W / 2 };
}

export class Game {
  balls: BallPos[];
  turn: Seat;
  breaker: Seat;
  groups: [Group | null, Group | null] = [null, null];
  phase: Phase = 'break';
  inHand: InHand = 'kitchen';
  winner: Seat | null = null;
  message = '';
  seq = 0;
  private rng: () => number;

  constructor(breaker: Seat, rng: () => number = Math.random) {
    this.rng = rng;
    this.breaker = breaker;
    this.turn = breaker;
    this.balls = rackBalls(rng);
    this.message = 'Lượt phá bi';
  }

  /** Dựng lại ván từ trạng thái đã gửi đi (máy dùng để đánh thử các cú trước khi chọn). */
  static fromView(v: GameView, rng: () => number = Math.random): Game {
    const g = new Game(v.breaker, rng);
    g.balls = v.balls.map((b) => ({ ...b }));
    g.turn = v.turn;
    g.groups = [v.groups[0], v.groups[1]];
    g.phase = v.phase;
    g.inHand = v.inHand;
    g.winner = v.winner;
    g.message = v.message;
    g.seq = v.seq;
    return g;
  }

  view(): GameView {
    return {
      balls: this.balls.map((b) => ({ ...b })),
      turn: this.turn,
      breaker: this.breaker,
      groups: [this.groups[0], this.groups[1]],
      phase: this.phase,
      inHand: this.inHand,
      winner: this.winner,
      message: this.message,
      onEight: this.phase === 'play' && this.remaining(this.turn) === 0 && this.groups[this.turn] !== null,
      seq: this.seq,
    };
  }

  /** Số bi nhóm của người chơi còn trên bàn (-1 nếu bàn còn mở). */
  private remaining(p: Seat): number {
    const g = this.groups[p];
    if (!g) return -1;
    return this.balls.filter((b) => !b.pocketed && groupOf(b.id) === g).length;
  }

  private rerack(breaker: Seat): void {
    this.balls = rackBalls(this.rng);
    this.breaker = breaker;
    this.turn = breaker;
    this.groups = [null, null];
    this.phase = 'break';
    this.inHand = 'kitchen';
  }

  /** Người chơi chọn sau khi đối thủ phá bi lỗi. */
  choose(player: Seat, choice: Choice): GameView {
    this.seq++;
    if (this.phase !== 'choice' || player !== this.turn) throw new RuleError('Hiện không phải lúc chọn.');
    if (choice === 'accept') {
      this.phase = 'play';
      this.message = this.inHand === 'kitchen' ? 'Bạn nhận bàn, đặt bi cái sau vạch phá bi' : 'Bạn nhận bàn và đánh tiếp';
    } else if (choice === 'rerack-self') {
      this.rerack(player);
      this.message = 'Xếp lại bi – bạn phá bi';
    } else if (choice === 'rerack-other') {
      this.rerack(other(player));
      this.message = 'Xếp lại bi – đối thủ phá bi';
    } else throw new RuleError('Lựa chọn không hợp lệ.');
    return this.view();
  }

  /** Hết giờ: phạm lỗi, đối thủ được đặt bi tự do. */
  timeout(player: Seat): GameView {
    this.seq++;
    if (this.phase === 'over' || player !== this.turn) return this.view();
    if (this.phase === 'choice') return this.choose(player, 'accept');
    if (this.phase === 'break') {
      this.turn = other(player);
      this.breaker = this.turn;
      this.message = 'Hết giờ phá bi – đối thủ phá bi';
      return this.view();
    }
    this.turn = other(player);
    this.inHand = 'anywhere';
    this.respotCue();
    this.message = 'Hết giờ – lỗi! Đối thủ được đặt bi cái tự do';
    return this.view();
  }

  forfeit(loser: Seat, reason: string): GameView {
    this.seq++;
    this.phase = 'over';
    this.winner = other(loser);
    this.message = reason;
    return this.view();
  }

  private respotCue(): void {
    const cue = this.balls[0];
    if (cue.pocketed || !validCuePos(this.balls, cue, 'anywhere')) {
      const p = freeSpot(this.balls, this.inHand === 'kitchen' ? 'kitchen' : 'anywhere');
      cue.x = p.x; cue.y = p.y; cue.pocketed = false;
    }
  }

  shoot(player: Seat, input: ShotInput): ShotOutcome {
    if (this.phase !== 'break' && this.phase !== 'play') throw new RuleError('Chưa thể đánh lúc này.');
    if (player !== this.turn) throw new RuleError('Chưa đến lượt của bạn.');
    const pr = input.params;
    if (![pr.dx, pr.dy, pr.power, pr.spinX, pr.spinY].every(Number.isFinite) || (pr.dx === 0 && pr.dy === 0)) {
      throw new RuleError('Thông số cú đánh không hợp lệ.');
    }
    if (pr.power <= 0) throw new RuleError('Lực đánh quá nhỏ.');

    if (this.inHand !== 'none') {
      if (input.cuePos) {
        if (!validCuePos(this.balls, input.cuePos, this.inHand)) throw new RuleError('Vị trí đặt bi cái không hợp lệ.');
        this.balls[0].x = input.cuePos.x;
        this.balls[0].y = input.cuePos.y;
      } else if (!validCuePos(this.balls, this.balls[0], this.inHand)) {
        throw new RuleError('Hãy đặt bi cái vào vị trí hợp lệ.');
      }
    }
    this.balls[0].pocketed = false;

    const startOwn = this.remaining(player);
    const needsCall = this.phase === 'play' && startOwn === 0;
    if (needsCall && !(Number.isInteger(input.calledPocket) && input.calledPocket! >= 0 && input.calledPocket! < 6)) {
      throw new RuleError('Hãy chỉ định lỗ cho bi số 8.');
    }

    this.seq++;
    const start = this.balls.map((b) => ({ ...b }));
    const sim = new Sim(start);
    sim.applyShot(pr);
    sim.run();
    const final = sim.snapshot();
    const events = sim.events;

    const foul = this.phase === 'break'
      ? this.resolveBreak(player, final, events)
      : this.resolvePlay(player, final, events, startOwn, input.calledPocket);

    return { player, start, params: { ...pr }, events, duration: sim.time, foul, view: this.view() };
  }

  private resolveBreak(player: Seat, final: BallPos[], events: SimEvent[]): string | null {
    const pocketed = events.filter((e): e is Extract<SimEvent, { type: 'pocket' }> => e.type === 'pocket').map((e) => e.ball);
    const cueScratch = pocketed.includes(0);
    const objPocketed = pocketed.filter((id) => id !== 0);
    const cushionBalls = new Set<number>();
    for (const e of events) if (e.type === 'cushion' && e.ball !== 0) cushionBalls.add(e.ball);
    const touched = events.some((e) => e.type === 'ball' && (e.a === 0 || e.b === 0));
    this.balls = final;

    if (objPocketed.includes(8)) {
      this.rerack(cueScratch ? other(player) : player);
      this.message = cueScratch
        ? 'Bi 8 xuống lỗ và bi cái lọt lỗ khi phá – xếp lại bi, đối thủ phá bi'
        : 'Bi 8 xuống lỗ khi phá – xếp lại bi, bạn phá lại';
      return null;
    }

    const legal = !cueScratch && touched && (objPocketed.length > 0 || cushionBalls.size >= 4);
    if (!legal) {
      const reason = cueScratch ? 'Bi cái lọt lỗ khi phá bi' : !touched ? 'Bi cái không chạm bi nào' : 'Phá bi không hợp lệ (chưa đủ 4 bi chạm băng)';
      this.turn = other(player);
      this.phase = 'choice';
      if (cueScratch) { this.inHand = 'kitchen'; this.respotCue(); } else this.inHand = 'none';
      this.message = `${reason}. Đối thủ chọn: nhận bàn hay xếp lại bi`;
      return reason;
    }

    this.phase = 'play';
    this.inHand = 'none';
    if (objPocketed.length > 0) {
      this.turn = player;
      this.message = 'Phá bi tốt! Bàn còn mở – đánh tiếp';
    } else {
      this.turn = other(player);
      this.message = 'Phá bi hợp lệ. Bàn còn mở';
    }
    return null;
  }

  private resolvePlay(player: Seat, final: BallPos[], events: SimEvent[], startOwn: number, called?: number): string | null {
    const pockets = events.filter((e): e is Extract<SimEvent, { type: 'pocket' }> => e.type === 'pocket');
    const pocketed = pockets.map((e) => e.ball);
    const cueScratch = pocketed.includes(0);
    const objPocketed = pocketed.filter((id) => id !== 0);
    const open = this.groups[player] === null;
    const myGroup = this.groups[player];
    const onEight = !open && startOwn === 0;

    let first: number | null = null;
    let firstT = 0;
    for (const e of events) {
      if (e.type === 'ball' && (e.a === 0 || e.b === 0)) { first = e.a === 0 ? e.b : e.a; firstT = e.t; break; }
    }
    const cushionAfter = first !== null && events.some((e) => e.type === 'cushion' && e.t >= firstT);

    let foul: string | null = null;
    if (cueScratch) foul = 'Bi cái lọt lỗ';
    else if (first === null) foul = 'Bi cái không chạm bi nào';
    else if (onEight) { if (first !== 8) foul = 'Phải chạm bi số 8 trước'; }
    else if (open) { if (first === 8) foul = 'Không được chạm bi 8 đầu tiên khi bàn còn mở'; }
    else if (groupOf(first) !== myGroup) foul = 'Chạm bi của đối thủ trước';
    if (!foul && !cushionAfter && objPocketed.length === 0) foul = 'Không có bi nào chạm băng sau khi va chạm';

    this.balls = final;
    const lose = (reason: string): null => {
      this.phase = 'over';
      this.winner = other(player);
      this.message = reason;
      return null;
    };

    if (objPocketed.includes(8)) {
      const pk = pockets.find((e) => e.ball === 8)!.pocket;
      this.inHand = 'none';
      if (foul) { lose(`Bi 8 xuống lỗ cùng lỗi (${foul}) – thua ván`); return foul; }
      if (!onEight) { lose('Bi 8 xuống lỗ khi chưa hết bi nhóm mình – thua ván'); return 'Đánh bi 8 xuống lỗ quá sớm'; }
      if (pk !== called) { lose('Bi 8 vào sai lỗ đã chỉ định – thua ván'); return 'Bi 8 vào sai lỗ'; }
      this.phase = 'over';
      this.winner = player;
      this.message = 'Bi 8 vào lỗ – thắng ván!';
      return null;
    }

    // gán nhóm khi bàn còn mở
    if (open && !foul) {
      const hasS = objPocketed.some((id) => groupOf(id) === 'solids');
      const hasT = objPocketed.some((id) => groupOf(id) === 'stripes');
      if (hasS !== hasT) {
        const g: Group = hasS ? 'solids' : 'stripes';
        this.groups[player] = g;
        this.groups[other(player)] = g === 'solids' ? 'stripes' : 'solids';
      }
    }

    if (foul) {
      this.turn = other(player);
      this.inHand = 'anywhere';
      this.respotCue();
      this.message = `Lỗi: ${foul}. Đối thủ được đặt bi cái tự do`;
      return foul;
    }

    this.inHand = 'none';
    const mine = this.groups[player];
    const scored = mine === null ? objPocketed.length > 0 : objPocketed.some((id) => groupOf(id) === mine);
    if (scored) {
      this.turn = player;
      this.message = mine && open ? `Bạn đánh ${mine === 'solids' ? 'bi trơn (1-7)' : 'bi sọc (9-15)'}` : 'Bi vào lỗ – đánh tiếp';
    } else {
      this.turn = other(player);
      this.message = objPocketed.length ? 'Chỉ vào bi của đối thủ – đổi lượt' : 'Đổi lượt';
    }
    return null;
  }
}
