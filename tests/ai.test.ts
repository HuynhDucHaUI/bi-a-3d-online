import { describe, expect, it } from 'vitest';
import { AI_LEVELS, planShot } from '@shared/ai';
import { BALL_R, TABLE_L, TABLE_W } from '@shared/constants';
import { Game, Group, InHand, validCuePos } from '@shared/game';
import { BallPos } from '@shared/physics';

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mkBalls = (placed: Record<number, [number, number]>): BallPos[] => {
  const out: BallPos[] = [];
  for (let i = 0; i < 16; i++) {
    const p = placed[i];
    out.push(p ? { id: i, x: p[0], y: p[1], pocketed: false } : { id: i, x: 9, y: 9, pocketed: true });
  }
  return out;
};

function playGame(balls: BallPos[], groups: [Group | null, Group | null], inHand: InHand = 'none'): Game {
  const g = new Game(0, () => 0.5);
  g.balls = balls;
  g.phase = 'play';
  g.turn = 1;
  g.groups = groups;
  g.inHand = inHand;
  return g;
}

/** Bàn ngẫu nhiên: mỗi bi còn trên bàn với xác suất `keep`, không chồng lên nhau. */
function randomTable(r: () => number, keep: number): BallPos[] {
  const placed: Record<number, [number, number]> = {};
  const free = (x: number, y: number) => Object.values(placed).every(([px, py]) => Math.hypot(px - x, py - y) > 2.2 * BALL_R);
  for (let id = 0; id < 16; id++) {
    if (id !== 0 && id !== 8 && r() > keep) continue;
    for (let k = 0; k < 100; k++) {
      const x = 0.15 + r() * (TABLE_L - 0.3), y = 0.12 + r() * (TABLE_W - 0.24);
      if (free(x, y)) { placed[id] = [x, y]; break; }
    }
  }
  return mkBalls(placed);
}

describe('máy chơi (luyện tập)', () => {
  it('mọi cấp độ đều chọn cú đánh hợp lệ theo luật (bàn mở, có nhóm, cầm bi, đánh bi 8)', async () => {
    const r = rng(7);
    const states: Game[] = [
      playGame(randomTable(r, 0.7), [null, null]),
      playGame(randomTable(r, 0.5), ['solids', 'stripes']),
      playGame(randomTable(r, 0.5), ['stripes', 'solids'], 'anywhere'),
      playGame(mkBalls({ 0: [0.8, 0.5], 8: [1.9, 0.9], 3: [1.3, 0.3] }), ['solids', 'stripes']),
    ];
    for (const level of AI_LEVELS) {
      for (const g of states) {
        const v = g.view();
        const input = await planShot(v, 1, level, { rng: r });
        expect(() => Game.fromView(v).shoot(1, input)).not.toThrow();
        if (v.inHand !== 'none') expect(validCuePos(v.balls, input.cuePos!, v.inHand)).toBe(true);
        if (v.onEight) expect(input.calledPocket).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120000);

  it('máy khó và chuyên nghiệp đưa được bi thẳng lỗ, kể cả cú cắt vừa phải', async () => {
    // bi 1 cách lỗ góc phải-dưới ~45 cm, bi cái cắt ~25 độ
    const balls = mkBalls({ 0: [1.35, 0.45], 1: [2.2, 0.32], 9: [1.0, 1.0] });
    const r = rng(3);
    for (const level of ['hard', 'pro'] as const) {
      let made = 0;
      for (let i = 0; i < 4; i++) {
        const g = playGame(balls.map((b) => ({ ...b })), ['stripes', 'solids']);
        const out = g.shoot(1, await planShot(g.view(), 1, level, { rng: r }));
        if (out.events.some((e) => e.type === 'pocket' && e.ball === 1)) made++;
      }
      expect(made).toBeGreaterThanOrEqual(3);
    }
  }, 60000);

  it('cấp dễ vẫn đánh trúng bi (không phạm lỗi không chạm bi) ở bàn đơn giản', async () => {
    const balls = mkBalls({ 0: [0.8, 0.6], 2: [1.4, 0.7], 12: [2.0, 0.3] });
    const r = rng(11);
    let touched = 0;
    for (let i = 0; i < 10; i++) {
      const g = playGame(balls.map((b) => ({ ...b })), ['stripes', 'solids']);
      const out = g.shoot(1, await planShot(g.view(), 1, 'easy', { rng: r }));
      if (out.foul !== 'Bi cái không chạm bi nào' && out.foul !== 'Chạm bi của đối thủ trước') touched++;
    }
    expect(touched).toBeGreaterThanOrEqual(9);
  });
});
