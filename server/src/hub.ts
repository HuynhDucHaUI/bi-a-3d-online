import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { RECONNECT_SECONDS, TURN_SECONDS } from '../../shared/constants';
import { AI_LEVEL_NAME, AI_LEVELS, AiLevel, planChoice, planShot } from '../../shared/ai';
import { Choice, Game, RuleError, Seat, ShotInput } from '../../shared/game';
import type { Ack, AimMsg, ClientToServer, RoomView, ServerToClient } from '../../shared/protocol';

type IO = Server<ClientToServer, ServerToClient>;
type Sock = Socket<ClientToServer, ServerToClient>;

interface Member {
  token: string;
  name: string;
  socketId: string | null;
  seat: Seat | null;
  roomCode: string | null;
  lastChatAt: number;
  lastAimAt: number;
  forfeitTimer?: NodeJS.Timeout;
  /** máy chơi (chế độ luyện tập): không có kết nối nhưng luôn coi như đang online */
  bot?: boolean;
}

interface Room {
  code: string;
  isPublic: boolean;
  seats: [string | null, string | null]; // token
  members: Set<string>;
  game: Game | null;
  scores: [number, number];
  rematch: [boolean, boolean];
  nextBreaker: Seat;
  deadlineAt: number | null;
  turnTimer?: NodeJS.Timeout;
  timeouts: [number, number];
  counted: boolean;
  /** phòng luyện tập 1 người với máy (máy ngồi ghế BOT_SEAT, không đếm giờ) */
  practice: AiLevel | null;
  botTimer?: NodeJS.Timeout;
}

const BOT_SEAT: Seat = 1;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sanitizeName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) : '';
  return s || `Khách ${Math.floor(100 + Math.random() * 900)}`;
}

export class Hub {
  private members = new Map<string, Member>();
  private rooms = new Map<string, Room>();

  constructor(private io: IO) {
    io.on('connection', (socket) => this.onConnection(socket));
  }

  stats() {
    return { rooms: this.rooms.size, players: this.members.size };
  }

  // ---------- kết nối ----------
  private onConnection(socket: Sock): void {
    let me: Member | null = null;
    const need = (): Member | null => me;

    socket.on('hello', (data, ack) => {
      const token = typeof data?.token === 'string' && this.members.has(data.token) && !this.members.get(data.token)!.bot ? data.token : randomUUID();
      let m = this.members.get(token);
      if (!m) {
        m = { token, name: sanitizeName(data?.name), socketId: null, seat: null, roomCode: null, lastChatAt: 0, lastAimAt: 0 };
        this.members.set(token, m);
      }
      // ngắt socket cũ của cùng người chơi (mở nhiều tab)
      if (m.socketId && m.socketId !== socket.id) this.io.sockets.sockets.get(m.socketId)?.disconnect(true);
      m.socketId = socket.id;
      if (m.forfeitTimer) { clearTimeout(m.forfeitTimer); m.forfeitTimer = undefined; }
      me = m;
      const room = m.roomCode ? this.rooms.get(m.roomCode) : undefined;
      if (room) {
        socket.join(room.code);
        this.broadcast(room);
      } else m.roomCode = null;
      ack({ token, room: room ? this.viewFor(room, m) : null });
    });

    socket.on('room:create', (data, ack) => {
      const m = need();
      if (!m) return ack({ ok: false, error: 'Chưa kết nối.' });
      m.name = sanitizeName(data?.name);
      this.leave(m);
      const room = this.createRoom(!!data?.isPublic);
      this.enter(room, m, false, socket);
      ack({ ok: true });
    });

    socket.on('room:join', (data, ack) => {
      const m = need();
      if (!m) return ack({ ok: false, error: 'Chưa kết nối.' });
      const code = String(data?.code ?? '').trim().toUpperCase();
      const room = this.rooms.get(code);
      if (!room) return ack({ ok: false, error: 'Không tìm thấy phòng.' });
      m.name = sanitizeName(data?.name);
      if (m.roomCode === code) { this.broadcast(room); return ack({ ok: true }); }
      const full = room.seats[0] !== null && room.seats[1] !== null;
      if (full && !data?.spectate) return ack({ ok: false, error: 'Phòng đã đủ 2 người. Bạn có thể vào xem.' });
      this.leave(m);
      this.enter(room, m, !!data?.spectate || full, socket);
      ack({ ok: true });
    });

    socket.on('room:quick', (data, ack) => {
      const m = need();
      if (!m) return ack({ ok: false, error: 'Chưa kết nối.' });
      m.name = sanitizeName(data?.name);
      this.leave(m);
      let target: Room | undefined;
      for (const r of this.rooms.values()) {
        const filled = r.seats.filter((s) => s !== null).length;
        if (r.isPublic && filled === 1 && r.seats.some((t) => t && this.members.get(t)?.socketId)) { target = r; break; }
      }
      const room = target ?? this.createRoom(true);
      this.enter(room, m, false, socket);
      ack({ ok: true });
    });

    socket.on('room:practice', (data, ack) => {
      const m = need();
      if (!m) return ack({ ok: false, error: 'Chưa kết nối.' });
      const level = data?.level;
      if (!AI_LEVELS.includes(level)) return ack({ ok: false, error: 'Cấp độ không hợp lệ.' });
      m.name = sanitizeName(data?.name);
      this.leave(m);
      const room = this.createRoom(false);
      room.practice = level;
      const bot: Member = {
        token: `bot:${room.code}`, name: `Máy (${AI_LEVEL_NAME[level]})`, socketId: null, seat: BOT_SEAT, roomCode: room.code,
        lastChatAt: 0, lastAimAt: 0, bot: true,
      };
      this.members.set(bot.token, bot);
      room.seats[BOT_SEAT] = bot.token;
      this.enter(room, m, false, socket);
      ack({ ok: true });
    });

    socket.on('room:leave', () => { const m = need(); if (m) this.leave(m); });

    socket.on('aim', (data) => {
      const m = need();
      const room = m && m.roomCode ? this.rooms.get(m.roomCode) : undefined;
      if (!m || !room || !room.game || m.seat === null || room.game.turn !== m.seat) return;
      const now = Date.now();
      if (now - m.lastAimAt < 40) return;
      m.lastAimAt = now;
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const msg: AimMsg = { dx: num(data?.dx), dy: num(data?.dy), power: num(data?.power), spinX: num(data?.spinX), spinY: num(data?.spinY) };
      if (typeof data?.cx === 'number' && typeof data?.cy === 'number') { msg.cx = data.cx; msg.cy = data.cy; }
      if (typeof data?.calledPocket === 'number') msg.calledPocket = data.calledPocket;
      socket.to(room.code).emit('aim', msg);
    });

    socket.on('shot', (data, ack) => {
      const m = need();
      const room = m && m.roomCode ? this.rooms.get(m.roomCode) : undefined;
      if (!m || !room || !room.game || m.seat === null) return ack({ ok: false, error: 'Bạn không ở trong ván đấu.' });
      try {
        this.playShot(room, m.seat, sanitizeShot(data));
        ack({ ok: true });
      } catch (e) {
        if (e instanceof RuleError) return ack({ ok: false, error: e.message });
        console.error('shot error', e);
        ack({ ok: false, error: 'Lỗi máy chủ khi xử lý cú đánh.' });
      }
    });

    socket.on('choice', (data: Choice, ack) => {
      const m = need();
      const room = m && m.roomCode ? this.rooms.get(m.roomCode) : undefined;
      if (!m || !room || !room.game || m.seat === null) return ack({ ok: false, error: 'Bạn không ở trong ván đấu.' });
      try {
        room.game.choose(m.seat, data);
        this.afterGameChange(room, 0);
        this.broadcast(room);
        ack({ ok: true });
      } catch (e) {
        ack({ ok: false, error: e instanceof RuleError ? e.message : 'Lỗi.' });
      }
    });

    socket.on('chat', (text) => {
      const m = need();
      const room = m && m.roomCode ? this.rooms.get(m.roomCode) : undefined;
      if (!m || !room || typeof text !== 'string') return;
      const now = Date.now();
      if (now - m.lastChatAt < 400) return;
      m.lastChatAt = now;
      const t = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
      if (t) this.io.to(room.code).emit('chat', { name: m.name, text: t, seat: m.seat });
    });

    socket.on('rematch', () => {
      const m = need();
      const room = m && m.roomCode ? this.rooms.get(m.roomCode) : undefined;
      if (!m || !room || m.seat === null || !room.game || room.game.phase !== 'over') return;
      room.rematch[m.seat] = true;
      if (room.rematch[0] && room.rematch[1]) this.startGame(room);
      this.broadcast(room);
    });

    socket.on('disconnect', () => {
      const m = me;
      if (!m || m.socketId !== socket.id) return;
      m.socketId = null;
      const room = m.roomCode ? this.rooms.get(m.roomCode) : undefined;
      if (!room) { this.members.delete(m.token); return; }
      this.broadcast(room);
      m.forfeitTimer = setTimeout(() => {
        const r = m.roomCode ? this.rooms.get(m.roomCode) : undefined;
        if (!r || m.socketId) return;
        if (m.seat !== null && r.game && r.game.phase !== 'over' && r.seats[0] && r.seats[1]) {
          r.game.forfeit(m.seat, `${m.name} mất kết nối – thua ván`);
          this.afterGameChange(r, 0);
          this.broadcast(r);
        }
        this.leave(m, true);
        this.members.delete(m.token);
      }, RECONNECT_SECONDS * 1000);
    });
  }

  // ---------- phòng ----------
  private createRoom(isPublic: boolean): Room {
    let code = '';
    do {
      code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    const room: Room = {
      code, isPublic, seats: [null, null], members: new Set(), game: null, scores: [0, 0], rematch: [false, false],
      nextBreaker: Math.random() < 0.5 ? 0 : 1, deadlineAt: null, timeouts: [0, 0], counted: false, practice: null,
    };
    this.rooms.set(code, room);
    return room;
  }

  private enter(room: Room, m: Member, spectate: boolean, socket: Sock): void {
    m.roomCode = room.code;
    room.members.add(m.token);
    socket.join(room.code);
    if (!spectate) {
      const seat: Seat = room.seats[0] === null ? 0 : 1;
      room.seats[seat] = m.token;
      m.seat = seat;
      room.scores = [0, 0];
      if (room.seats[0] && room.seats[1]) this.startGame(room);
    } else m.seat = null;
    this.broadcast(room);
  }

  /** Rời phòng (chủ động hoặc bị loại). */
  private leave(m: Member, silent = false): void {
    const room = m.roomCode ? this.rooms.get(m.roomCode) : undefined;
    m.roomCode = null;
    const seat = m.seat;
    m.seat = null;
    if (!room) return;
    if (m.socketId) this.io.sockets.sockets.get(m.socketId)?.leave(room.code);
    room.members.delete(m.token);
    if (seat !== null) {
      if (room.game && room.game.phase !== 'over' && room.seats[0] && room.seats[1]) {
        room.game.forfeit(seat, `${m.name} rời phòng – thua ván`);
        this.afterGameChange(room, 0);
      }
      room.seats[seat] = null;
      room.rematch = [false, false];
    }
    const anyone = [...room.members].some((t) => this.members.get(t)?.socketId);
    if (!anyone && !silent) this.removeRoom(room);
    else if (room.members.size === 0) this.removeRoom(room);
    else this.broadcast(room);
  }

  private removeRoom(room: Room): void {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    if (room.botTimer) clearTimeout(room.botTimer);
    for (const t of room.members) { const mm = this.members.get(t); if (mm) { mm.roomCode = null; mm.seat = null; } }
    for (const t of room.seats) if (t && this.members.get(t)?.bot) this.members.delete(t);
    this.rooms.delete(room.code);
  }

  private startGame(room: Room): void {
    room.game = new Game(room.nextBreaker);
    room.nextBreaker = room.nextBreaker === 0 ? 1 : 0;
    room.rematch = [false, false];
    room.timeouts = [0, 0];
    room.counted = false;
    this.armTimer(room, 0);
  }

  // ---------- thời gian ----------
  private armTimer(room: Room, extraMs: number): void {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = undefined;
    const g = room.game;
    if (room.practice) { room.deadlineAt = null; this.scheduleBot(room, extraMs); return; }
    if (!g || g.phase === 'over') { room.deadlineAt = null; return; }
    const ms = extraMs + TURN_SECONDS * 1000;
    room.deadlineAt = Date.now() + ms;
    room.turnTimer = setTimeout(() => {
      const gg = room.game;
      if (!gg || gg.phase === 'over') return;
      const seat = gg.turn;
      room.timeouts[seat]++;
      if (room.timeouts[seat] >= 3) gg.forfeit(seat, `${this.nameOfSeat(room, seat)} hết giờ 3 lần liên tiếp – thua ván`);
      else gg.timeout(seat);
      this.afterGameChange(room, 0);
      this.broadcast(room);
    }, ms);
  }

  private remaining(room: Room): number | null {
    return room.deadlineAt === null ? null : Math.max(0, room.deadlineAt - Date.now());
  }

  private afterGameChange(room: Room, extraMs: number): void {
    const g = room.game;
    if (g && g.phase === 'over' && !room.counted) {
      room.counted = true;
      if (g.winner !== null) room.scores[g.winner]++;
    }
    this.armTimer(room, extraMs);
  }

  /** Thực hiện cú đánh (của người hoặc máy) rồi phát kết quả cho cả phòng. Luật từ chối thì ném RuleError. */
  private playShot(room: Room, seat: Seat, input: ShotInput): void {
    const outcome = room.game!.shoot(seat, input);
    room.timeouts[seat] = 0;
    if (process.env.BIA_LOG) console.log(`[${room.code}] ${this.nameOfSeat(room, seat)} (ghế ${seat}) lực ${input.params.power.toFixed(2)} → ${outcome.foul ?? 'ok'} | ${outcome.view.message}`);
    const extra = Math.ceil(outcome.duration * 1000) + 2500;
    this.afterGameChange(room, extra);
    this.io.to(room.code).emit('shot:result', { outcome, remainingMs: this.remaining(room) ?? 0 });
    // gửi kèm trạng thái phòng (tỉ số khi hết ván, cờ chơi lại...) — shot:result chỉ có trạng thái ván
    this.broadcast(room);
  }

  // ---------- máy chơi (luyện tập) ----------
  /** Đến lượt máy thì hẹn giờ cho máy đi (đợi người chơi xem xong cú vừa đánh). Hết ván thì máy luôn sẵn sàng chơi lại. */
  private scheduleBot(room: Room, delayMs: number): void {
    if (room.botTimer) clearTimeout(room.botTimer);
    room.botTimer = undefined;
    const g = room.game;
    if (!g) return;
    if (g.phase === 'over') { room.rematch[BOT_SEAT] = true; return; }
    if (g.turn !== BOT_SEAT) return;
    const seq = g.seq;
    room.botTimer = setTimeout(() => void this.botMove(room, seq), delayMs + 700);
  }

  private async botMove(room: Room, seq: number): Promise<void> {
    room.botTimer = undefined;
    const alive = () => this.rooms.get(room.code) === room && room.game?.seq === seq;
    const g = room.game;
    const level = room.practice;
    if (!g || !level || !alive()) return;
    try {
      if (g.phase === 'choice') {
        g.choose(BOT_SEAT, planChoice());
        this.afterGameChange(room, 0);
        this.broadcast(room);
        return;
      }
      // máy đánh thử hàng trăm cú: nhường luồng xử lý giữa chừng để các phòng khác không bị khựng
      const input = await planShot(g.view(), BOT_SEAT, level, { pause: () => new Promise((r) => setImmediate(r)) });
      if (!(await this.botAim(room, input, alive))) return;
      this.playShot(room, BOT_SEAT, input);
    } catch (e) {
      console.error('bot error', e);
      // không để ván bị treo: tính như máy hết giờ (người chơi được đặt bi tự do)
      if (alive()) { g.timeout(BOT_SEAT); this.afterGameChange(room, 0); this.broadcast(room); }
    }
  }

  /** Cho người chơi xem máy ngắm: xoay cơ dần về hướng đánh, kéo lực rồi mới đánh. */
  private async botAim(room: Room, input: ShotInput, alive: () => boolean): Promise<boolean> {
    const g = room.game!;
    const p = input.params;
    const cue = input.cuePos ?? g.balls[0];
    const end = Math.atan2(p.dy, p.dx);
    const swing = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.35);
    const send = (a: number, power: number) => {
      const msg: AimMsg = { dx: Math.cos(a), dy: Math.sin(a), power, spinX: p.spinX, spinY: p.spinY };
      if (g.inHand !== 'none') { msg.cx = cue.x; msg.cy = cue.y; }
      if (input.calledPocket !== undefined) msg.calledPocket = input.calledPocket;
      this.io.to(room.code).emit('aim', msg);
    };
    const STEP_MS = 60;
    for (let i = 0; i <= 18; i++) {
      if (!alive()) return false;
      send(end + swing * (1 - i / 18) ** 3, 0);
      await wait(STEP_MS);
    }
    await wait(300);
    for (let i = 1; i <= 10; i++) {
      if (!alive()) return false;
      send(end, (p.power * i) / 10);
      await wait(STEP_MS);
    }
    await wait(150);
    return alive();
  }

  private nameOfSeat(room: Room, seat: Seat): string {
    const t = room.seats[seat];
    return (t && this.members.get(t)?.name) || `Người chơi ${seat + 1}`;
  }

  // ---------- gửi dữ liệu ----------
  private viewFor(room: Room, m: Member): RoomView {
    const info = (t: string | null) => {
      const mm = t ? this.members.get(t) : undefined;
      return mm ? { name: mm.name, connected: mm.socketId !== null || !!mm.bot } : null;
    };
    return {
      code: room.code,
      seats: [info(room.seats[0]), info(room.seats[1])],
      spectators: [...room.members].filter((t) => this.members.get(t)?.seat === null).length,
      game: room.game ? room.game.view() : null,
      you: m.seat,
      remainingMs: this.remaining(room),
      scores: [room.scores[0], room.scores[1]],
      rematch: [room.rematch[0], room.rematch[1]],
      isPublic: room.isPublic,
      practice: room.practice,
    };
  }

  private broadcast(room: Room): void {
    for (const t of room.members) {
      const m = this.members.get(t);
      if (m?.socketId) this.io.to(m.socketId).emit('room', this.viewFor(room, m));
    }
  }
}

function sanitizeShot(data: ShotInput): ShotInput {
  if (!data || typeof data !== 'object' || !data.params) throw new RuleError('Dữ liệu cú đánh không hợp lệ.');
  const p = data.params;
  const input: ShotInput = {
    params: { dx: Number(p.dx), dy: Number(p.dy), power: Math.min(1, Number(p.power)), spinX: Number(p.spinX), spinY: Number(p.spinY) },
  };
  if (data.cuePos) input.cuePos = { x: Number(data.cuePos.x), y: Number(data.cuePos.y) };
  if (typeof data.calledPocket === 'number') input.calledPocket = data.calledPocket;
  return input;
}

export type { Ack };
