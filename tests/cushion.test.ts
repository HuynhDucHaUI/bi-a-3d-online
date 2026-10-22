import { describe, expect, it } from 'vitest';
import { BALL_R } from '@shared/constants';
import { BallPos, Sim } from '@shared/physics';

/** Bàn chỉ có bi cái tại (x, y). */
const solo = (x: number, y: number): Sim => {
  const all: BallPos[] = [];
  for (let i = 0; i < 16; i++) all.push(i === 0 ? { id: 0, x, y, pocketed: false } : { id: i, x: 9, y: 9, pocketed: true });
  return new Sim(all);
};

/** Chạy tới ngay sau lần chạm băng đầu tiên. */
const untilCushion = (sim: Sim) => {
  while (!sim.events.some((e) => e.type === 'cushion') && sim.time < 5) sim.step();
  return { ...sim.cue };
};

const run = (sim: Sim, secs: number) => { const t = sim.time + secs; while (sim.time < t) sim.step(); };

describe('va chạm băng (mô hình Han 2005)', () => {
  it('bi lăn tự nhiên đập thẳng vào băng: bật ra 65-85% tốc độ và tiếp tục chạy ra xa băng', () => {
    const V = 2;
    const sim = solo(0.9, 0.5);
    const c = sim.cue;
    c.vy = V; c.wx = -V / BALL_R; // lăn tự nhiên về phía băng trên
    const after = untilCushion(sim);
    expect(after.vy).toBeLessThan(-0.65 * V);
    expect(after.vy).toBeGreaterThan(-0.85 * V);
    // băng chạm phía trên tâm nên "ăn" gần hết xoáy lăn: bi không bị ghì ngược lại về băng
    expect(Math.abs(after.wx)).toBeLessThan((0.35 * V) / BALL_R);
    run(sim, 0.6);
    expect(sim.cue.vy).toBeLessThan(-0.4 * V); // mô hình cũ chỉ còn ~0.23V do giữ nguyên xoáy lăn
  });

  it('bi trượt (không xoáy) chạm băng chéo 30°: góc bật gần đối xứng', () => {
    const sim = solo(1.0, 0.9);
    const a = (30 * Math.PI) / 180;
    sim.cue.vx = 1.5 * Math.sin(a);
    sim.cue.vy = 1.5 * Math.cos(a);
    const after = untilCushion(sim);
    const out = Math.atan2(Math.abs(after.vx), Math.abs(after.vy)) * (180 / Math.PI);
    expect(after.vy).toBeLessThan(0);
    expect(out).toBeGreaterThan(20);
    expect(out).toBeLessThan(34);
  });

  it('english thuận làm góc bật mở rộng, english nghịch làm góc bật hẹp lại', () => {
    const angleOut = (wz: number) => {
      const sim = solo(2.2, 0.6);
      const v = 1.4;
      sim.cue.vx = v * Math.SQRT1_2; // lao chéo lên phía băng phải
      sim.cue.vy = v * Math.SQRT1_2;
      sim.cue.wx = -sim.cue.vy / BALL_R;
      sim.cue.wy = sim.cue.vx / BALL_R;
      sim.cue.wz = wz;
      const after = untilCushion(sim);
      return Math.atan2(Math.abs(after.vy), Math.abs(after.vx)) * (180 / Math.PI); // so với pháp tuyến băng
    };
    const running = angleOut(-60); // xoay cùng chiều "lăn dọc băng"
    const none = angleOut(0);
    const reverse = angleOut(60);
    expect(running).toBeGreaterThan(none + 1.5); // băng pool (mu ~0.2): english đổi góc bật vài độ
    expect(reverse).toBeLessThan(none - 1.5);
  });

  it('bi đánh xoáy trên mạnh vào băng vẫn bật ra (không dính băng)', () => {
    const sim = solo(0.9, 0.6);
    sim.applyShot({ dx: 0, dy: 1, power: 0.4, spinX: 0, spinY: 1 });
    untilCushion(sim);
    run(sim, 0.3);
    expect(sim.cue.vy).toBeLessThan(-0.2);
  });

  it('kết quả hoàn toàn tất định', () => {
    const go = () => {
      const sim = solo(0.7, 0.3);
      sim.applyShot({ dx: 0.8, dy: 0.6, power: 0.9, spinX: -0.7, spinY: 0.4 });
      sim.run();
      return JSON.stringify(sim.snapshot());
    };
    expect(go()).toBe(go());
  });
});

describe('đường đi bi cái sau va chạm bi mục tiêu (quy tắc 30° và 90°)', () => {
  const two = (): Sim => {
    const all: BallPos[] = [];
    for (let i = 0; i < 16; i++) all.push({ id: i, x: 9, y: 9, pocketed: true });
    all[0] = { id: 0, x: 0.5, y: 0.5, pocketed: false };
    all[1] = { id: 1, x: 1.0, y: 0.5 + BALL_R, pocketed: false }; // trúng nửa bi -> góc cắt 30°
    return new Sim(all);
  };
  const deg = (x: number, y: number) => (Math.atan2(y, x) * 180) / Math.PI;

  it('quy tắc 30°: bi cái lăn tự nhiên, trúng nửa bi -> lệch khoảng 30° (27-36°)', () => {
    const sim = two();
    sim.applyShot({ dx: 1, dy: 0, power: 0.15, spinX: 0, spinY: 0.8 }); // xoáy trên 0.8 = lăn tự nhiên
    while (!sim.events.some((e) => e.type === 'ball')) sim.step();
    const p0 = { x: sim.cue.x, y: sim.cue.y };
    run(sim, 0.8);
    const ang = Math.abs(deg(sim.cue.x - p0.x, sim.cue.y - p0.y));
    expect(ang).toBeGreaterThan(27);
    expect(ang).toBeLessThan(36);
  });

  it('quy tắc 90°: bi cái "stun" -> đi vuông góc với hướng bi mục tiêu', () => {
    const sim = two();
    sim.applyShot({ dx: 1, dy: 0, power: 0.55, spinX: 0, spinY: -0.12 }); // ~3.3 m/s
    while (!sim.events.some((e) => e.type === 'ball')) sim.step();
    sim.step();
    const cue = deg(sim.cue.vx, sim.cue.vy);
    const obj = deg(sim.balls[1].vx, sim.balls[1].vy);
    expect(Math.abs(Math.abs(cue - obj) - 90)).toBeLessThan(6);
  });
});
