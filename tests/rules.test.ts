import { describe, expect, it } from 'vitest';
import { TABLE_L, TABLE_W } from '@shared/constants';
import { BallPos } from '@shared/physics';
import { Game, groupOf, rackBalls, validCuePos } from '@shared/game';

const mkBalls = (placed: Record<number, [number, number]>): BallPos[] => {
  const out: BallPos[] = [];
  for (let i = 0; i < 16; i++) {
    const p = placed[i];
    out.push(p ? { id: i, x: p[0], y: p[1], pocketed: false } : { id: i, x: 9, y: 9, pocketed: true });
  }
  return out;
};

/** Tạo ván đang ở giai đoạn 'play' với bố cục tuỳ ý. */
function playGame(placed: Record<number, [number, number]>, turn: 0 | 1 = 0, groups: ['solids' | 'stripes' | null, 'solids' | 'stripes' | null] = [null, null]): Game {
  const g = new Game(0, () => 0.5);
  g.balls = mkBalls(placed);
  g.phase = 'play';
  g.turn = turn;
  g.groups = groups;
  g.inHand = 'none';
  return g;
}

describe('rack', () => {
  it('có đủ 16 bi, bi 8 ở giữa hàng 3, hai góc sau là một trơn một sọc', () => {
    for (const seed of [0.1, 0.5, 0.9]) {
      const balls = rackBalls(() => seed);
      expect(balls.map((b) => b.id)).toEqual([...Array(16).keys()]);
      const rowOf = (id: number) => balls.filter((b) => b.id > 0).sort((a, b) => a.x - b.x || a.y - b.y);
      void rowOf;
      const back = balls.filter((b) => b.id > 0 && b.x > balls[8].x + 0.09);
      expect(back.length).toBe(5);
      const ys = back.map((b) => b.y).sort((a, b) => a - b);
      const corners = back.filter((b) => b.y === ys[0] || b.y === ys[4]).map((b) => groupOf(b.id));
      expect(new Set(corners).size).toBe(2);
      expect(balls[8].x).toBeGreaterThan(balls[0].x);
    }
  });
});

describe('validCuePos', () => {
  it('chặn đặt bi cái chồng bi khác, ngoài bàn hoặc ngoài vạch phá bi', () => {
    const balls = mkBalls({ 0: [0.5, 0.6], 1: [1, 0.6] });
    expect(validCuePos(balls, { x: 1.02, y: 0.6 }, 'anywhere')).toBe(false);
    expect(validCuePos(balls, { x: -1, y: 0.6 }, 'anywhere')).toBe(false);
    expect(validCuePos(balls, { x: 1.5, y: 0.6 }, 'kitchen')).toBe(false);
    expect(validCuePos(balls, { x: 0.4, y: 0.6 }, 'kitchen')).toBe(true);
    expect(validCuePos(balls, { x: 0.01, y: 0.01 }, 'anywhere')).toBe(false);
  });
});

describe('luật 8 bi', () => {
  it('đánh trúng bi trơn vào lỗ trên bàn mở -> nhận bi trơn và đánh tiếp', () => {
    const g = playGame({ 0: [0.3, 0.3], 1: [0.15, 0.15], 9: [2, 1], 8: [1.5, 0.3] });
    // bi 1 nằm gần lỗ góc (0,0); bi cái đánh thẳng vào nó theo hướng lỗ
    const out = g.shoot(0, { params: { dx: -1, dy: -1, power: 0.35, spinX: 0, spinY: 0 } });
    expect(out.foul).toBeNull();
    expect(g.groups[0]).toBe('solids');
    expect(g.groups[1]).toBe('stripes');
    expect(g.turn).toBe(0);
  });

  it('không chạm bi nào -> lỗi, đối thủ được đặt bi tự do', () => {
    const g = playGame({ 0: [0.5, 0.6], 1: [2, 1], 9: [2, 0.3] });
    const out = g.shoot(0, { params: { dx: 0, dy: 1, power: 0.3, spinX: 0, spinY: 0 } });
    expect(out.foul).not.toBeNull();
    expect(g.turn).toBe(1);
    expect(g.inHand).toBe('anywhere');
  });

  it('chạm bi của đối thủ trước -> lỗi (bàn đã chia nhóm)', () => {
    const g = playGame({ 0: [0.5, 0.6], 1: [2, 1], 9: [0.9, 0.6] }, 0, ['solids', 'stripes']);
    // bi 9 là sọc, người chơi 0 là trơn
    const out = g.shoot(0, { params: { dx: 1, dy: 0, power: 0.4, spinX: 0, spinY: 0 } });
    expect(out.foul).toMatch(/đối thủ/);
    expect(g.turn).toBe(1);
  });

  it('chạm bi 8 đầu tiên khi bàn còn mở là lỗi', () => {
    const g = playGame({ 0: [0.5, 0.6], 8: [0.9, 0.6], 1: [2, 1], 9: [2, 0.3] });
    const out = g.shoot(0, { params: { dx: 1, dy: 0, power: 0.4, spinX: 0, spinY: 0 } });
    expect(out.foul).toMatch(/bi 8/i);
  });

  it('bi cái lọt lỗ là lỗi', () => {
    const g = playGame({ 0: [0.3, 0.3], 1: [2, 1], 9: [2, 0.3] });
    const out = g.shoot(0, { params: { dx: -1, dy: -1, power: 0.4, spinX: 0, spinY: 0 } });
    expect(out.foul).toBe('Bi cái lọt lỗ');
    expect(g.balls[0].pocketed).toBe(false);
    expect(g.inHand).toBe('anywhere');
  });

  it('đánh bi 8 vào lỗ khi chưa hết bi nhóm -> thua', () => {
    const g = playGame({ 0: [0.3, 0.3], 8: [0.15, 0.15], 1: [2, 1], 9: [2, 0.3] }, 0, ['solids', 'stripes']);
    g.shoot(0, { params: { dx: -1, dy: -1, power: 0.35, spinX: 0, spinY: 0 } });
    expect(g.phase).toBe('over');
    expect(g.winner).toBe(1);
  });

  it('hết bi nhóm mình, đánh bi 8 vào đúng lỗ chỉ định -> thắng', () => {
    const g = playGame({ 0: [0.3, 0.3], 8: [0.15, 0.15], 9: [2, 0.3] }, 0, ['solids', 'stripes']);
    expect(() => g.shoot(0, { params: { dx: -1, dy: -1, power: 0.35, spinX: 0, spinY: 0 } })).toThrow(/lỗ/);
    g.shoot(0, { params: { dx: -1, dy: -1, power: 0.35, spinX: 0, spinY: 0 }, calledPocket: 0 });
    expect(g.phase).toBe('over');
    expect(g.winner).toBe(0);
  });

  it('bi 8 vào sai lỗ đã chỉ định -> thua', () => {
    const g = playGame({ 0: [0.3, 0.3], 8: [0.15, 0.15], 9: [2, 0.3] }, 0, ['solids', 'stripes']);
    g.shoot(0, { params: { dx: -1, dy: -1, power: 0.35, spinX: 0, spinY: 0 }, calledPocket: 3 });
    expect(g.winner).toBe(1);
  });

  it('không đúng lượt thì bị từ chối', () => {
    const g = playGame({ 0: [0.5, 0.6], 1: [2, 1], 9: [2, 0.3] });
    expect(() => g.shoot(1, { params: { dx: 1, dy: 0, power: 0.3, spinX: 0, spinY: 0 } })).toThrow();
  });
});

describe('phá bi', () => {
  it('phá bi mạnh hợp lệ hoặc đối thủ được chọn; luôn kết thúc ở trạng thái nhất quán', () => {
    for (let s = 1; s <= 6; s++) {
      let k = s;
      const g = new Game(0, () => ((k = (k * 9301 + 49297) % 233280) / 233280));
      const out = g.shoot(0, { params: { dx: 1, dy: 0.001 * s, power: 1, spinX: 0, spinY: 0 } });
      expect(['play', 'choice', 'break']).toContain(g.phase);
      if (g.phase === 'choice') {
        expect(out.foul).not.toBeNull();
        expect(g.turn).toBe(1);
        const v = g.choose(1, 'rerack-self');
        expect(v.phase).toBe('break');
        expect(v.balls.filter((b) => !b.pocketed).length).toBe(16);
        expect(v.turn).toBe(1);
      }
      expect(TABLE_L).toBeGreaterThan(TABLE_W);
    }
  });
});
