// Chẩn đoán tốc độ bi qua nhiều cú đánh ngẫu nhiên:
//  - bi tự tăng tốc khi không có va chạm (lỗi tích phân)
//  - năng lượng tăng sau va chạm bi - bi (lỗi va chạm)
//  - phân bố tỉ lệ tốc độ sau/trước khi chạm băng
// Dùng: npx tsx scripts/speed-diag.ts [số cú]
import { BALL_R } from '../shared/constants';
import { rackBalls } from '../shared/game';
import { Ball, Sim } from '../shared/physics';

const SHOTS = Number(process.argv[2] ?? 300);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// động năng tịnh tiến + quay (m = 1, I = 2/5 R^2)
const energy = (b: Ball) => 0.5 * (b.vx * b.vx + b.vy * b.vy) + 0.2 * BALL_R * BALL_R * (b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
const speed = (b: Ball) => Math.hypot(b.vx, b.vy);

let maxJumpNoEvent = 0;
let energyGains = 0;
let worstGain = 0;
const cushionRatios: number[] = [];

for (let shot = 0; shot < SHOTS; shot++) {
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
    const evBefore = sim.events.length;
    sim.step();
    const evs = sim.events.slice(evBefore);
    const touched = new Set<number>();
    for (const e of evs) {
      if (e.type === 'ball') {
        touched.add(e.a); touched.add(e.b);
        const e0 = energy(before[e.a]) + energy(before[e.b]);
        const e1 = energy(sim.balls[e.a]) + energy(sim.balls[e.b]);
        if (e1 > e0 * 1.001 + 1e-6) { energyGains++; worstGain = Math.max(worstGain, e1 / e0); }
      } else {
        touched.add(e.ball);
        if (e.type === 'cushion' && speed(before[e.ball]) > 0.3) cushionRatios.push(speed(sim.balls[e.ball]) / speed(before[e.ball]));
      }
    }
    for (const b of sim.balls) {
      if (b.pocketed || touched.has(b.id)) continue;
      maxJumpNoEvent = Math.max(maxJumpNoEvent, speed(b) - speed(before[b.id]));
    }
  }
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((p, q) => p - q);
  const q = (f: number) => s[Math.floor(f * (s.length - 1))].toFixed(3);
  return `n=${s.length} min=${q(0)} p10=${q(0.1)} trung vị=${q(0.5)} p90=${q(0.9)} max=${q(1)}`;
};
console.log(`Tăng tốc lớn nhất trong 1 bước (0.5ms) khi không va chạm: ${maxJumpNoEvent.toFixed(4)} m/s`);
console.log(`Số va chạm bi-bi làm TĂNG năng lượng: ${energyGains}${energyGains ? ` (tệ nhất x${worstGain.toFixed(3)})` : ''}`);
console.log(`Tỉ lệ tốc độ sau/trước khi chạm băng: ${stats(cushionRatios)}`);
