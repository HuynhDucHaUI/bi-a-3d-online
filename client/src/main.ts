import { isMuted, setMuted, unlockAudio } from './audio';
import { GameClient } from './game';
import { ask, connect, store } from './net';
import { gpuName, pickQuality, TableScene } from './render/scene';
import { Ui } from './ui';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const gpu = gpuName();
const scene = new TableScene(canvas, pickQuality(gpu));
const ui = new Ui();
let game: GameClient;

const params = new URLSearchParams(location.search);
const inviteCode = (params.get('room') ?? '').toUpperCase();
let wasInRoom = false;

const socket = connect(
  (room) => {
    if (room) { wasInRoom = true; ui.setName(room.seats[room.you ?? 0]?.name ?? store.name); game.setRoom(room); }
    else {
      if (wasInRoom) { wasInRoom = false; game.leaveRoom(); ui.showLobby(); }
      else if (inviteCode) tryInvite();
    }
  },
  (online) => ui.setOnline(online),
);
game = new GameClient(scene, ui, socket, canvas);

function tryInvite(): void {
  ui.setCode(inviteCode);
  ui.showLobby('Nhập tên rồi bấm "Vào chơi" để vào phòng ' + inviteCode);
}

function validName(name: string): string | null {
  if (!name) { ui.showLobby('Hãy nhập tên của bạn.'); return null; }
  store.name = name;
  return name;
}

async function enter(event: 'room:create' | 'room:join' | 'room:quick', data: any): Promise<void> {
  ui.lobbyBusy(true);
  ui.clearChat();
  const r = await ask(socket, event, data);
  ui.lobbyBusy(false);
  if (!r.ok) ui.showLobby(r.error);
  else {
    if (inviteCode) history.replaceState(null, '', location.pathname);
  }
}

ui.init({
  quick: (n) => { const name = validName(n); if (name) void enter('room:quick', { name }); },
  create: (n, isPublic) => { const name = validName(n); if (name) void enter('room:create', { name, isPublic }); },
  join: (n, code, spectate) => {
    const name = validName(n);
    if (!name) return;
    if (code.trim().length < 3) { ui.showLobby('Hãy nhập mã phòng.'); return; }
    void enter('room:join', { name, code, spectate });
  },
  leave: () => { socket.emit('room:leave'); wasInRoom = false; game.leaveRoom(); ui.showLobby(); },
  view: (m) => game.setView(m),
  spin: (x, y) => game.setSpin(x, y),
  spinClosed: () => game.closeSpinBig(),
  powerDrag: (p, rel) => game.powerDragBar(p, rel),
  replace: () => game.replace(),
  call: (i) => game.callPocket(i),
  choice: (c) => { void ask(socket, 'choice', c).then((r) => { if (!r.ok) ui.toast(r.error); }); },
  rematch: () => socket.emit('rematch'),
  chat: (t) => socket.emit('chat', t),
  quality: () => {
    try { localStorage.setItem('bia.quality', scene.quality === 'high' ? 'low' : 'high'); } catch { /* bỏ qua */ }
    location.reload();
  },
  mute: () => { setMuted(!isMuted()); if (!isMuted()) unlockAudio(); return isMuted(); },
});

socket.on('room', (room) => {
  if (!room) return;
  wasInRoom = true;
  game.setRoom(room);
});
socket.on('shot:result', (m) => game.onShotResult(m));
socket.on('aim', (m) => game.onAim(m));
socket.on('chat', (m) => ui.addChat(m));
socket.on('toast', (t) => ui.toast(t));

ui.showLobby();
if (inviteCode) tryInvite();
ui.setQuality(scene.quality, gpu);
if (/swiftshader|llvmpipe|basic render|microsoft basic/i.test(gpu)) {
  ui.toast('Trình duyệt đang vẽ bằng CPU – hãy bật "Hardware acceleration" trong cài đặt trình duyệt để chơi mượt');
}

// Ở sảnh bàn bi-a bị che hết nên chỉ vẽ 1 khung/giây cho nhẹ máy.
let lobbyTick = 0;
function lobbyFrame(): boolean {
  lobbyTick++;
  return lobbyTick % 60 !== 0;
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.update(dt);
  if (!ui.inLobby || !lobbyFrame()) scene.render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// phục vụ kiểm thử / gỡ lỗi
(window as any).__bia = { scene, game, socket };
