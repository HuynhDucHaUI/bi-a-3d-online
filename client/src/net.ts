import { io, Socket } from 'socket.io-client';
import type { ClientToServer, RoomView, ServerToClient } from '@shared/protocol';

export type ClientSocket = Socket<ServerToClient, ClientToServer>;

const TOKEN_KEY = 'bia.token';
const NAME_KEY = 'bia.name';

export const store = {
  get token(): string | undefined {
    try { return localStorage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; }
  },
  set token(v: string | undefined) {
    try { if (v) localStorage.setItem(TOKEN_KEY, v); } catch { /* bỏ qua */ }
  },
  get name(): string {
    try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
  },
  set name(v: string) {
    try { localStorage.setItem(NAME_KEY, v); } catch { /* bỏ qua */ }
  },
};

export function connect(onReady: (room: RoomView | null) => void, onStatus: (online: boolean) => void): ClientSocket {
  const socket: ClientSocket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });
  socket.on('connect', () => {
    socket.emit('hello', { token: store.token, name: store.name }, (r) => {
      store.token = r.token;
      onStatus(true);
      onReady(r.room);
    });
  });
  socket.on('disconnect', () => onStatus(false));
  return socket;
}

export function ask<T extends 'room:create' | 'room:join' | 'room:quick' | 'room:practice' | 'shot' | 'choice'>(
  socket: ClientSocket, event: T, data: Parameters<ClientToServer[T]>[0],
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Máy chủ không phản hồi.' }), 8000);
    (socket as any).emit(event, data, (r: any) => { clearTimeout(timer); resolve(r); });
  });
}
