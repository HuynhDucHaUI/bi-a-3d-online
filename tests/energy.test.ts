import { describe, expect, it } from 'vitest';
import { BALL_R } from '@shared/constants';
import { rackBalls } from '@shared/game';
import { Ball, Sim } from '@shared/physics';

// động năng tịnh tiến + quay (m = 1, I = 2/5 R^2)
const energy = (b: Ball) => 0.5 * (b.vx * b.vx + b.vy * b.vy) + 0.2 * BALL_R * BALL_R * (b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
const speed = (b: Ball) => Math.hypot(b.vx, b.vy);

describe('tốc độ bi nhất quán qua nhiều cú đánh ngẫu nhiên', () => {
  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let energyGains = 0;
  let maxJump = 0;
  const cushion: number[] = [];

  for (let shot = 0; shot < 60; shot++) {
    const balls = rackBalls(rnd);
    if (shot % 2) for (const b of balls) { b.x = 0.1 + rnd() * 2.34; b.y = 0.1 + rnd() * 1.07; }
    for (let i = 0; i < balls.length; i++) for (let j = 0; j < i; j++) {
      if (!balls[j].pocketed && Math.hypot(balls[i].x - balls[j].x, balls[i].y - balls[j].y) < 2 * BALL_R + 0.002) balls[i].pocketed = true;
    }
    balls[0].pocketed = false;
    const sim = new Sim(balls);
    const a = rnd() * Math.PI * 2;
    sim.applyShot({ dx: Math.cos(a), dy: Math.sin(a), power: 0.15 + rnd() * 0.85, spinX: rnd() * 2 - 1, spinY: rnd() * 2 - 1 });
    while (sim.moving && sim.time < 60) {
      const before = sim.balls.map((b) => ({ ...b }));
      const n0 = sim.events.length;
      sim.step();
      const touched = new Set<number>();
      for (const e of sim.events.slice(n0)) {
        if (e.type === 'ball') {
          touched.add(e.a); touched.add(e.b);
          if (energy(sim.balls[e.a]) + energy(sim.balls[e.b]) > (energy(before[e.a]) + energy(before[e.b])) * 1.001 + 1e-6) energyGains++;
        } else {
          touched.add(e.ball);
          if (e.type === 'cushion' && speed(before[e.ball]) > 0.3) cushion.push(speed(sim.balls[e.ball]) / speed(before[e.ball]));
        }
      }
      for (const b of sim.balls) if (!b.pocketed && !touched.has(b.id)) maxJump = Math.max(maxJump, speed(b) - speed(before[b.id]));
    }
  }

  it('va chạm bi - bi không bao giờ tạo thêm năng lượng', () => {
    expect(energyGains).toBe(0);
  });

  it('bi không tự tăng tốc khi không va chạm (chỉ ma sát nỉ đổi xoáy thành tốc độ rất chậm)', () => {
    expect(maxJump).toBeLessThan(0.025);
  });

  it('tốc độ sau khi chạm băng ổn định: đa số 60-95%, không vọt quá 1.12 lần', () => {
    const s = [...cushion].sort((x, y) => x - y);
    const q = (f: number) => s[Math.floor(f * (s.length - 1))];
    expect(s.length).toBeGreaterThan(50);
    expect(q(0.1)).toBeGreaterThan(0.6);
    expect(q(0.9)).toBeLessThan(0.95);
    expect(q(1)).toBeLessThan(1.12);
  });
});
