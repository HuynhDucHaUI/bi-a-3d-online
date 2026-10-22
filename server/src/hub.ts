import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { RECONNECT_SECONDS, TURN_SECONDS } from '../../shared/constants';
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
}

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
      const token = typeof data?.token === 'string' && this.members.has(data.token) ? data.token : randomUUID();
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
        const input = sanitizeShot(data);
        const outcome = room.game.shoot(m.seat, input);
        room.timeouts[m.seat] = 0;
        if (process.env.BIA_LOG) console.log(`[${room.code}] ${m.name} (ghế ${m.seat}) lực ${input.params.power.toFixed(2)} → ${outcome.foul ?? 'ok'} | ${outcome.view.message}`);
        const extra = Math.ceil(outcome.duration * 1000) + 2500;
        this.afterGameChange(room, extra);
        this.io.to(room.code).emit('shot:result', { outcome, remainingMs: this.remaining(room) ?? 0 });
        // gửi kèm trạng thái phòng (tỉ số khi hết ván, cờ chơi lại...) — shot:result chỉ có trạng thái ván
        this.broadcast(room);
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
      nextBreaker: Math.random() < 0.5 ? 0 : 1, deadlineAt: null, timeouts: [0, 0], counted: false,
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
    for (const t of room.members) { const mm = this.members.get(t); if (mm) { mm.roomCode = null; mm.seat = null; } }
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

  private nameOfSeat(room: Room, seat: Seat): string {
    const t = room.seats[seat];
    return (t && this.members.get(t)?.name) || `Người chơi ${seat + 1}`;
  }

  // ---------- gửi dữ liệu ----------
  private viewFor(room: Room, m: Member): RoomView {
    const info = (t: string | null) => {
      const mm = t ? this.members.get(t) : undefined;
      return mm ? { name: mm.name, connected: mm.socketId !== null } : null;
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
