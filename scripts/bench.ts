// Đo tốc độ engine: thời gian mô phỏng trung bình mỗi cú đánh.
import { rackBalls } from '../shared/game';
import { Sim } from '../shared/physics';
let seed = 99;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const shots = 150;
let simSeconds = 0;
const t0 = performance.now();
for (let i = 0; i < shots; i++) {
  const sim = new Sim(rackBalls(rnd));
  const a = (rnd() - 0.5) * 0.3;
  sim.applyShot({ dx: Math.cos(a), dy: Math.sin(a), power: 0.3 + rnd() * 0.7, spinX: 0, spinY: 0 });
  sim.run();
  simSeconds += sim.time;
}
const ms = performance.now() - t0;
console.log(`${shots} cú phá bi: ${(ms / shots).toFixed(1)} ms/cú, ${(ms / simSeconds).toFixed(2)} ms cho mỗi giây mô phỏng (${(simSeconds / shots).toFixed(1)} s mô phỏng/cú)`);
