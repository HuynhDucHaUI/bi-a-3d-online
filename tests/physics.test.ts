import { describe, expect, it } from 'vitest';
import { BALL_R, TABLE_L, TABLE_W } from '@shared/constants';
import { BallPos, Sim } from '@shared/physics';
import { rackBalls } from '@shared/game';

const ball = (id: number, x: number, y: number): BallPos => ({ id, x, y, pocketed: false });
const empty = (...bs: BallPos[]): BallPos[] => {
  const all: BallPos[] = [];
  for (let i = 0; i < 16; i++) all.push(bs.find((b) => b.id === i) ?? { id: i, x: 5 + i, y: 5, pocketed: true });
  return all;
};

describe('physics', () => {
  it('bi dừng lại và không rơi lỗ khi đánh nhẹ giữa bàn', () => {
    const sim = new Sim(empty(ball(0, 0.6, 0.6)));
    sim.applyShot({ dx: 1, dy: 0, power: 0.2, spinX: 0, spinY: 0 });
    sim.run();
    expect(sim.cue.pocketed).toBe(false);
    expect(sim.cue.x).toBeGreaterThan(0.6);
    expect(sim.cue.vx).toBe(0);
  });

  it('cú đánh giống hệt nhau cho cùng đầu vào (tất định)', () => {
    const run = () => {
      const s = new Sim(rackBalls(() => 0.37));
      s.applyShot({ dx: 1, dy: 0.01, power: 1, spinX: 0.3, spinY: -0.2 });
      s.run();
      return JSON.stringify(s.snapshot());
    };
    expect(run()).toBe(run());
  });

  /** Chạy đến ngay sau va chạm bi-bi đầu tiên cộng thêm `extra` giây. */
  const afterContact = (sim: Sim, extra: number) => {
    while (!sim.events.some((e) => e.type === 'ball') && sim.time < 5) sim.step();
    const t0 = sim.time;
    while (sim.time < t0 + extra) sim.step();
  };

  it('đánh thẳng: bi mục tiêu đi thẳng theo hướng đánh', () => {
    const sim = new Sim(empty(ball(0, 0.8, 0.635), ball(1, 1.2, 0.635)));
    sim.applyShot({ dx: 1, dy: 0, power: 0.6, spinX: 0, spinY: 0 }); // ~3.7 m/s
    afterContact(sim, 0.3);
    const obj = sim.balls[1];
    expect(Math.abs(obj.y - 0.635)).toBeLessThan(0.002);
    expect(obj.vx).toBeGreaterThan(2);
    expect(Math.abs(sim.cue.vx)).toBeLessThan(0.8);
  });

  it('xoáy dưới làm bi cái kéo ngược lại sau va chạm', () => {
    const sim = new Sim(empty(ball(0, 0.8, 0.635), ball(1, 1.2, 0.635)));
    sim.applyShot({ dx: 1, dy: 0, power: 0.5, spinX: 0, spinY: -1 });
    afterContact(sim, 0.4);
    expect(sim.cue.vx).toBeLessThan(-0.3);
  });

  it('xoáy trên làm bi cái chạy theo sau va chạm', () => {
    const sim = new Sim(empty(ball(0, 0.8, 0.635), ball(1, 1.2, 0.635)));
    sim.applyShot({ dx: 1, dy: 0, power: 0.5, spinX: 0, spinY: 0.9 });
    afterContact(sim, 0.4);
    expect(sim.cue.vx).toBeGreaterThan(0.5);
  });

  it('bi vào lỗ góc khi đánh thẳng vào lỗ', () => {
    const sim = new Sim(empty(ball(0, 0.3, 0.3)));
    sim.applyShot({ dx: -1, dy: -1, power: 0.5, spinX: 0, spinY: 0 });
    sim.run();
    expect(sim.cue.pocketed).toBe(true);
    expect(sim.events.some((e) => e.type === 'pocket' && e.pocket === 0)).toBe(true);
  });

  it('bi vào lỗ giữa', () => {
    const sim = new Sim(empty(ball(0, TABLE_L / 2, 0.4)));
    sim.applyShot({ dx: 0, dy: -1, power: 0.5, spinX: 0, spinY: 0 });
    sim.run();
    expect(sim.cue.pocketed).toBe(true);
  });

  it('bi nảy băng và vẫn ở trong bàn', () => {
    const sim = new Sim(empty(ball(0, 1.0, 0.6)));
    sim.applyShot({ dx: 0.3, dy: 1, power: 1, spinX: 0.5, spinY: 0 });
    sim.run();
    expect(sim.events.some((e) => e.type === 'cushion')).toBe(true);
    for (const b of sim.balls) {
      if (b.pocketed) continue;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(TABLE_L);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeLessThanOrEqual(TABLE_W);
    }
  });

  it('cú phá bi mạnh: các bi không chồng lên nhau và có ít nhất vài bi chạm băng', () => {
    const sim = new Sim(rackBalls(() => 0.5));
    sim.applyShot({ dx: 1, dy: 0.002, power: 1, spinX: 0, spinY: 0.2 });
    sim.run();
    const live = sim.balls.filter((b) => !b.pocketed);
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const d = Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y);
      expect(d).toBeGreaterThan(2 * BALL_R - 0.003);
    }
    const cushionBalls = new Set(sim.events.filter((e) => e.type === 'cushion').map((e) => (e as any).ball));
    expect(cushionBalls.size).toBeGreaterThanOrEqual(4);
    expect(sim.time).toBeLessThan(40);
  });
});
