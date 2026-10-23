// Định nghĩa thông điệp giữa client và server.
import type { AiLevel } from './ai';
import type { Choice, GameView, Seat, ShotInput, ShotOutcome } from './game';

export interface PlayerInfo {
  name: string;
  connected: boolean;
}

export interface RoomView {
  code: string;
  seats: [PlayerInfo | null, PlayerInfo | null];
  spectators: number;
  game: GameView | null;
  /** Ghế của người nhận (null = người xem) */
  you: Seat | null;
  /** Số mili-giây còn lại của lượt hiện tại (null = không đếm giờ) */
  remainingMs: number | null;
  scores: [number, number];
  rematch: [boolean, boolean];
  isPublic: boolean;
  /** Phòng luyện tập với máy (máy ngồi ghế 1), null = phòng 2 người */
  practice: AiLevel | null;
}

export interface AimMsg {
  dx: number;
  dy: number;
  power: number;
  spinX: number;
  spinY: number;
  /** Vị trí bi cái khi đang cầm bi (đặt tự do) */
  cx?: number;
  cy?: number;
  calledPocket?: number | null;
}

export interface ChatMsg {
  name: string;
  text: string;
  seat: Seat | null;
}

export interface ShotResultMsg {
  outcome: ShotOutcome;
  remainingMs: number;
}

export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ClientToServer {
  hello: (data: { token?: string; name?: string }, ack: (r: { token: string; room: RoomView | null }) => void) => void;
  'room:create': (data: { name: string; isPublic: boolean }, ack: (r: Ack) => void) => void;
  'room:join': (data: { code: string; name: string; spectate?: boolean }, ack: (r: Ack) => void) => void;
  'room:quick': (data: { name: string }, ack: (r: Ack) => void) => void;
  'room:practice': (data: { name: string; level: AiLevel }, ack: (r: Ack) => void) => void;
  'room:leave': () => void;
  aim: (data: AimMsg) => void;
  shot: (data: ShotInput, ack: (r: Ack) => void) => void;
  choice: (data: Choice, ack: (r: Ack) => void) => void;
  chat: (text: string) => void;
  rematch: () => void;
}

export interface ServerToClient {
  room: (view: RoomView | null) => void;
  'shot:result': (msg: ShotResultMsg) => void;
  aim: (data: AimMsg) => void;
  chat: (msg: ChatMsg) => void;
  toast: (text: string) => void;
}
