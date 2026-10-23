// Cho máy các cấp độ đấu với nhau (không cần server) để kiểm tra độ mạnh và thời gian suy nghĩ.
// Dùng: npx tsx scripts/ai-match.ts [cấp A] [cấp B] [số ván]      vd. npx tsx scripts/ai-match.ts pro easy 10
import { AiLevel, planChoice, planShot } from '../shared/ai';
import { Game, RuleError, Seat } from '../shared/game';

const A = (process.argv[2] ?? 'hard') as AiLevel;
const B = (process.argv[3] ?? 'medium') as AiLevel;
const GAMES = Number(process.argv[4] ?? 6);

const stats = {
  wins: [0, 0], shots: [0, 0], pocketed: [0, 0], fouls: [0, 0], errors: 0, planMs: [0, 0], maxPlanMs: [0, 0], visits: [0, 0], runs: [0, 0],
};

async function main() {
  for (let n = 0; n < GAMES; n++) {
    const game = new Game((n % 2) as Seat);
    const levels: [AiLevel, AiLevel] = [A, B];
    let turns = 0;
    let lastTurn: Seat | null = null;
    let run = 0;
    while (game.phase !== 'over' && turns < 400) {
      turns++;
      const me = game.turn;
      if (me !== lastTurn) { stats.visits[me]++; lastTurn = me; run = 0; }
      if (game.phase === 'choice') { game.choose(me, planChoice()); continue; }
      const t0 = performance.now();
      const input = await planShot(game.view(), me, levels[me]);
      const ms = performance.now() - t0;
      stats.planMs[me] += ms;
      stats.maxPlanMs[me] = Math.max(stats.maxPlanMs[me], ms);
      try {
        const out = game.shoot(me, input);
        stats.shots[me]++;
        if (out.foul) stats.fouls[me]++;
        const potted = out.events.filter((e) => e.type === 'pocket' && e.ball !== 0).length;
        stats.pocketed[me] += potted;
        if (game.turn === me && game.phase !== 'over') { run++; stats.runs[me] = Math.max(stats.runs[me], run); }
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        stats.errors++;
        console.log(`  lỗi (${levels[me]}): ${e.message}`);
        game.timeout(me);
      }
    }
    if (game.winner !== null) stats.wins[game.winner]++;
    console.log(`Ván ${n + 1}: ${game.winner === null ? 'hoà/quá lượt' : levels[game.winner] + ` (ghế ${game.winner})`} thắng sau ${turns} lượt – ${game.message}`);
  }
  for (const s of [0, 1] as const) {
    const lv = s === 0 ? A : B;
    console.log(`${lv.padEnd(6)} thắng ${stats.wins[s]}/${GAMES} · ${stats.shots[s]} cú · vào ${stats.pocketed[s]} bi `
      + `(${(stats.pocketed[s] / Math.max(1, stats.shots[s])).toFixed(2)}/cú) · lỗi ${stats.fouls[s]} · chuỗi dài nhất ${stats.runs[s]} `
      + `· nghĩ TB ${(stats.planMs[s] / Math.max(1, stats.shots[s])).toFixed(0)} ms, tối đa ${stats.maxPlanMs[s].toFixed(0)} ms`);
  }
  if (stats.errors) console.log(`Cú đánh bị luật từ chối: ${stats.errors}`);
  process.exit(stats.errors ? 1 : 0);
}

void main();
