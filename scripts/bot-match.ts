// Hai bot chơi với nhau qua server thật để kiểm tra luồng mạng + luật chơi.
// Dùng: npx tsx scripts/bot-match.ts [số ván] [url]
import { io, Socket } from 'socket.io-client';
import { BALL_R } from '../shared/constants';
import { GameView, Seat, ShotInput, groupOf, validCuePos } from '../shared/game';
import { POCKET_CENTERS } from '../shared/physics';
import type { RoomView, ShotResultMsg } from '../shared/protocol';

const GAMES = Number(process.argv[2] ?? 3);
const URL = process.argv[3] ?? 'http://localhost:3000';

const norm = (x: number, y: number) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };

function chooseShot(g: GameView, me: Seat): ShotInput {
  const cue = g.balls[0];
  const group = g.groups[me];
  const targets = g.balls.filter((b) => !b.pocketed && b.id !== 0 && (g.onEight ? b.id === 8 : group === null ? b.id !== 8 : groupOf(b.id) === group));
  let best: { aim: { x: number; y: number }; score: number; dist: number; pocket: number } | null = null;
  for (const t of targets) {
    POCKET_CENTERS.forEach((pk, i) => {
      const inward = { x: pk.x + (pk.x === 0 ? 0.03 : pk.x > 1 ? -0.03 : 0), y: pk.y + (pk.y === 0 ? 0.03 : -0.03) };
      const d = norm(inward.x - t.x, inward.y - t.y);
      const ghost = { x: t.x - d.x * 2 * BALL_R, y: t.y - d.y * 2 * BALL_R };
      const aim = norm(ghost.x - cue.x, ghost.y - cue.y);
      const cut = aim.x * d.x + aim.y * d.y;
      if (cut < 0.35) return;
      const dist = Math.hypot(ghost.x - cue.x, ghost.y - cue.y) + Math.hypot(inward.x - t.x, inward.y - t.y);
      const score = cut - dist * 0.12;
      if (!best || score > best.score) best = { aim, score, dist, pocket: i };
    });
  }
  const noise = (Math.random() - 0.5) * 0.02;
  const params = { dx: 1, dy: 0, power: 0.5, spinX: 0, spinY: 0 };
  let calledPocket: number | undefined;
  if (best) {
    const b = best as { aim: { x: number; y: number }; dist: number; pocket: number };
    params.dx = b.aim.x - b.aim.y * noise; params.dy = b.aim.y + b.aim.x * noise;
    params.power = Math.min(1, Math.cbrt((0.22 + b.dist * 0.2) ** 2)); // bù đường cong lực p^1.5
    calledPocket = b.pocket;
  } else {
    const a = Math.random() * Math.PI * 2;
    params.dx = Math.cos(a); params.dy = Math.sin(a); params.power = 0.4 + Math.random() * 0.4;
    calledPocket = Math.floor(Math.random() * 6);
  }
  if (g.phase === 'break') { params.dx = 1; params.dy = (Math.random() - 0.5) * 0.02; params.power = 1; }
  const input: ShotInput = { params };
  if (g.onEight) input.calledPocket = calledPocket;
  if (g.inHand !== 'none' && g.phase !== 'break') {
    for (let i = 0; i < 300; i++) {
      const p = { x: 0.1 + Math.random() * 2.3, y: 0.1 + Math.random() * 1.05 };
      if (validCuePos(g.balls, p, g.inHand)) { input.cuePos = p; break; }
    }
    // hướng ngắm phải tính lại theo vị trí mới
    if (input.cuePos && best) {
      const c = input.cuePos;
      const t = targets[0];
      const a = norm(t.x - c.x, t.y - c.y);
      params.dx = a.x; params.dy = a.y;
    }
  }
  return input;
}

interface Bot { name: string; sock: Socket; seat: Seat | null; room: RoomView | null; replayUntil: number; }

function makeBot(name: string): Promise<Bot> {
  return new Promise((resolve) => {
    const sock = io(URL, { transports: ['websocket'] });
    const bot: Bot = { name, sock, seat: null, room: null, replayUntil: 0 };
    sock.on('connect', () => sock.emit('hello', {}, () => resolve(bot)));
  });
}

const stats = { shots: 0, fouls: 0, pocketed: 0, errors: 0, games: 0, wins: [0, 0], longest: 0 };

async function main() {
  const a = await makeBot('BotA');
  const b = await makeBot('BotB');
  let over: (() => void) | null = null;
  const attach = (bot: Bot) => {
    bot.sock.on('room', (r) => { bot.room = r; bot.seat = r?.you ?? null; step(bot); });
    bot.sock.on('shot:result', (m: ShotResultMsg) => {
      if (bot === a) {
        stats.shots++;
        if (m.outcome.foul) stats.fouls++;
        stats.pocketed += m.outcome.events.filter((e) => e.type === 'pocket').length;
        stats.longest = Math.max(stats.longest, m.outcome.duration);
      }
      if (bot.room?.game) bot.room = { ...bot.room, game: m.outcome.view };
      step(bot);
    });
  };
  const busy = new Set<Bot>();
  function step(bot: Bot) {
    const r = bot.room;
    const g = r?.game;
    if (!r || !g || bot.seat === null || busy.has(bot)) return;
    if (g.phase === 'over') {
      if (bot === a && !r.rematch[0]) {
        stats.games++;
        if (g.winner !== null) stats.wins[g.winner]++;
        console.log(`Ván ${stats.games}: thắng = ${g.winner === null ? '?' : g.winner === 0 ? a.name : b.name} (${g.message})`);
        if (stats.games >= GAMES) { over?.(); return; }
        a.sock.emit('rematch'); b.sock.emit('rematch');
      }
      return;
    }
    if (g.turn !== bot.seat) return;
    busy.add(bot);
    setTimeout(() => {
      busy.delete(bot);
      const cur = bot.room?.game;
      if (!cur || cur.turn !== bot.seat || cur.phase === 'over') return;
      if (cur.phase === 'choice') { bot.sock.emit('choice', 'accept', (res: any) => { if (!res.ok) { stats.errors++; console.log('choice error', res.error); } }); return; }
      const input = chooseShot(cur, bot.seat!);
      bot.sock.emit('shot', input, (res: any) => {
        if (!res.ok) { stats.errors++; console.log(`[${bot.name}] lỗi:`, res.error); setTimeout(() => step(bot), 50); }
      });
    }, 30);
  }
  attach(a); attach(b);

  const done = new Promise<void>((res) => { over = res; });
  await new Promise<void>((resolve) => a.sock.emit('room:create', { name: 'BotA', isPublic: false }, () => resolve()));
  const code = await new Promise<string>((resolve) => { const t = setInterval(() => { if (a.room) { clearInterval(t); resolve(a.room.code); } }, 20); });
  // BOT_WAIT_MS: in mã phòng rồi chờ để người khác vào xem bằng trình duyệt trước khi bắt đầu
  if (process.env.BOT_WAIT_MS) { console.log('ROOM ' + code); await new Promise((r) => setTimeout(r, Number(process.env.BOT_WAIT_MS))); }
  await new Promise<void>((resolve) => b.sock.emit('room:join', { code, name: 'BotB' }, () => resolve()));
  const timer = setTimeout(() => { console.log('QUÁ GIỜ', JSON.stringify(stats)); process.exit(2); }, 240000);
  await done;
  clearTimeout(timer);
  // BOT_LINGER_MS: ở lại phòng thêm một lúc sau khi xong (để người xem thấy hộp kết quả)
  if (process.env.BOT_LINGER_MS) await new Promise((r) => setTimeout(r, Number(process.env.BOT_LINGER_MS)));
  console.log('Thống kê:', JSON.stringify(stats));
  a.sock.close(); b.sock.close();
  process.exit(stats.errors > 0 ? 1 : 0);
}

void main();
