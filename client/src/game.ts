// Điều khiển ván đấu phía client: ngắm, đánh, chạy lại cú đánh bằng engine dùng chung, đồng bộ với server.
import { BALL_R, DT, HEAD_STRING_X, TABLE_L, TABLE_W, TURN_SECONDS } from '@shared/constants';
import { GameView, validCuePos } from '@shared/game';
import { BallPos, ShotParams, Sim } from '@shared/physics';
import type { AimMsg, RoomView, ShotResultMsg } from '@shared/protocol';
import { playBall, playCue, playCushion, playPocket, playTick, unlockAudio } from './audio';
import { ask, ClientSocket } from './net';
import type { TableScene, ViewMode } from './render/scene';
import type { Ui } from './ui';

const PULL_MAX = 0.24;
const STROKE_TIME = 0.12;

interface Shot {
  start: BallPos[];
  params: ShotParams;
  /** Kết quả từ server (null khi máy mình đánh và đang chờ server xác nhận) */
  msg: ShotResultMsg | null;
}

interface Replay extends Shot {
  sim: Sim;
  /** mốc thời gian thực (performance.now) ứng với thời điểm 0 của mô phỏng */
  t0: number;
  eventIdx: number;
  done: boolean;
}

export class GameClient {
  room: RoomView | null = null;
  private pending: RoomView | null = null;
  private lastSeq = -1;
  private lastCode = '';

  // trạng thái ngắm của mình
  private dir = { x: 1, y: 0 };
  private power = 0;
  private spin = { x: 0, y: 0 };
  private cuePos = { x: HEAD_STRING_X, y: TABLE_W / 2 };
  private placing = false;
  private called: number | null = null;
  private charging = false;
  private localShot = false;
  private powerDrag: { x: number; y: number; id: number } | null = null;
  private aimDrag: number | null = null;
  private touches = new Set<number>();
  private keys = new Set<string>();
  private lastSent = 0;
  private lastSentKey = '';

  // trạng thái ngắm của đối thủ (làm mượt)
  private remote: AimMsg | null = null;
  private remoteS = { dx: 1, dy: 0, power: 0, spinX: 0, spinY: 0, cx: 0, cy: 0 };

  private stroke: (Shot & { t: number }) | null = null;
  private replay: Replay | null = null;
  private afterglow = 0;
  private queue: ShotResultMsg[] = [];
  private deadline: number | null = null;
  private lastTick = -1;
  /** Góc nhìn người chơi chọn (khi đánh ở "Sau gậy" sẽ tạm chuyển sang toàn cảnh rồi quay lại) */
  private preferredView: ViewMode = 'angled';
  /** Vị trí chuột trên canvas (để tự xoay cơ khi đưa chuột sát mép ở góc nhìn sau gậy) */
  private hover: { x: number; y: number; since: number } | null = null;
  /** đang giữ chuột phải để chỉnh điểm đánh */
  private spinDrag: { x: number; y: number; sx: number; sy: number; moved: boolean; id: number } | null = null;
  /** bảng điểm đánh lớn đang mở (bấm nhanh chuột phải) */
  private spinPinned = false;
  /** góc xoay còn chờ áp dụng từ con lăn (áp dần qua vài khung cho mượt) */
  private wheelPending = 0;
  /** tốc độ xoay hiện tại khi đưa chuột sát mép (tăng/giảm dần, không bật/tắt đột ngột) */
  private edgeVel = 0;

  constructor(private scene: TableScene, private ui: Ui, private socket: ClientSocket, private canvas: HTMLCanvasElement) {
    this.bindInput();
  }

  // ---------- trạng thái ----------
  private get g(): GameView | null {
    return this.room?.game ?? null;
  }

  private get busy(): boolean {
    return this.replay !== null || this.stroke !== null;
  }

  private get myTurn(): boolean {
    const g = this.g;
    return !!g && this.room!.you !== null && g.turn === this.room!.you && (g.phase === 'break' || g.phase === 'play') && !this.busy
      && !!this.room!.seats[0] && !!this.room!.seats[1];
  }

  leaveRoom(): void {
    this.room = null;
    this.pending = null;
    this.replay = null;
    this.stroke = null;
    this.localShot = false;
    this.queue = [];
    this.lastSeq = -1;
    this.lastCode = '';
    this.scene.setCue({ visible: false, x: 0, y: 0, dx: 1, dy: 0, pull: 0, spinX: 0, spinY: 0 });
    this.scene.setGuide({ visible: false, x: 0, y: 0, dx: 1, dy: 0 });
    this.scene.showPocket(null);
    this.ui.setPocketButtons([]);
    this.ui.setPowerTip(null);
  }

  setRoom(view: RoomView): void {
    // thời gian còn lại tính theo lúc NHẬN được tin (áp dụng muộn khi đang xem bi chạy cũng không lệch)
    this.deadline = view.remainingMs !== null ? performance.now() + view.remainingMs : null;
    if (this.busy) { this.pending = view; return; }
    this.applyRoom(view);
  }

  private applyRoom(view: RoomView): void {
    const first = this.lastCode !== view.code;
    this.lastCode = view.code;
    this.room = view;
    const g = view.game;
    if (g && (g.seq !== this.lastSeq || first)) this.newState(g);
    if (!g) this.scene.setBallsStatic([]);
    this.ui.sync(view, !this.busy);
    this.syncView();
  }

  private newState(g: GameView): void {
    this.lastSeq = g.seq;
    this.scene.setBallsStatic(g.balls);
    this.power = 0;
    this.charging = false;
    this.powerDrag = null;
    this.spin = { x: 0, y: 0 };
    this.called = null;
    this.ui.setPower(0);
    this.ui.setPowerTip(null);
    this.ui.setSpinDot(0, 0);
    this.closeSpinBig();
    this.scene.showPocket(null);
    this.remote = null;
    const cue = g.balls[0];
    this.cuePos = { x: cue.x, y: cue.y };
    const mine = !!this.room && this.room.you === g.turn && g.phase !== 'over' && !!this.room.seats[0] && !!this.room.seats[1];
    this.placing = mine && g.inHand !== 'none';
    // hướng ngắm mặc định: về phía viên bi gần nhất
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const b of g.balls) {
      if (b.id === 0 || b.pocketed) continue;
      const d = Math.hypot(b.x - cue.x, b.y - cue.y);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) { const l = Math.hypot(best.x - cue.x, best.y - cue.y) || 1; this.dir = { x: (best.x - cue.x) / l, y: (best.y - cue.y) / l }; }
    if (mine) {
      this.ui.banner(g.phase === 'choice' ? 'Chọn tiếp theo' : 'Đến lượt bạn');
      if (g.phase !== 'choice') this.ui.showControlsHelp();
    }
  }

/** "Sau gậy" chỉ dùng khi đang chơi; hết ván / đang chờ chọn thì về toàn cảnh, chơi tiếp thì quay lại. */
  private syncView(): void {
    if (this.busy) return;
    const g = this.g;
    const playable = !!g && (g.phase === 'break' || g.phase === 'play') && !!this.room?.seats[0] && !!this.room?.seats[1];
    const want: ViewMode = this.preferredView === 'cue' && !playable ? 'angled' : this.preferredView;
    if (this.scene.view !== want) this.scene.setView(want);
  }

  onAim(msg: AimMsg): void {
    this.remote = msg;
  }

  // ---------- cú đánh ----------
  onShotResult(msg: ShotResultMsg): void {
    this.deadline = performance.now() + msg.remainingMs;
    // cú đánh của chính mình đã được chạy trước trên máy: chỉ gắn kết quả chính thức
    if (this.localShot && this.room && msg.outcome.player === this.room.you) {
      this.localShot = false;
      if (this.stroke && !this.stroke.msg) { this.stroke.msg = msg; return; }
      if (this.replay && !this.replay.msg) {
        this.replay.msg = msg;
        if (this.replay.done) this.finishReplay(msg);
        return;
      }
    }
    if (this.busy) this.queue.push(msg);
    else this.beginStroke({ start: msg.outcome.start, params: msg.outcome.params, msg });
  }

  private beginStroke(shot: Shot): void {
    this.charging = false;
    this.powerDrag = null;
    this.ui.setPowerTip(null);
    this.scene.setBallsStatic(shot.start);
    this.scene.showPocket(null);
    this.ui.setPocketButtons([]);
    this.stroke = { ...shot, t: 0 };
    this.ui.hideModal();
    this.closeSpinBig();
    // đang ở góc nhìn sau gậy: chuyển nhanh sang toàn cảnh ngay khi ra cơ,
    // để camera đứng yên lúc bi chạy (camera di chuyển làm bi trông lúc nhanh lúc chậm)
    if (this.scene.view === 'cue') this.scene.setView('angled', 0.4);
  }

  private startSim(shot: Shot): void {
    const sim = new Sim(shot.start);
    sim.applyShot(shot.params);
    this.replay = { ...shot, sim, t0: performance.now(), eventIdx: 0, done: false };
    playCue(shot.params.power);
  }

  private finishReplay(msg: ShotResultMsg): void {
    this.replay = null;
    this.afterglow = 0;
    const out = msg.outcome;
    this.scene.setBallsStatic(out.view.balls);
    if (out.foul) this.ui.banner(out.foul, true);
    if (this.queue.length) {
      const next = this.queue.shift()!;
      this.beginStroke({ start: next.outcome.start, params: next.outcome.params, msg: next });
      return;
    }
    const p = this.pending;
    this.pending = null;
    const src = p ?? this.room;
    if (src) {
      // tin "room" đến trong lúc bi chạy có thể cũ hơn kết quả cú đánh (vd. đối thủ vừa nối lại mạng):
      // chỉ lấy phần ván đấu của nó nếu mới hơn, nếu không bàn sẽ nhảy về vị trí trước cú đánh
      const game = p?.game && p.game.seq >= out.view.seq ? p.game : out.view;
      this.applyRoom({ ...src, game });
    }
  }

  /** Server từ chối cú đánh đã chạy trước: quay lại trạng thái cũ. */
  private abortLocal(error: string): void {
    if (!this.localShot) return;
    this.localShot = false;
    this.stroke = null;
    this.replay = null;
    this.power = 0;
    this.ui.setPower(0);
    this.ui.toast(error);
    const g = this.g;
    if (g) this.scene.setBallsStatic(g.balls);
    if (this.pending) { const p = this.pending; this.pending = null; this.applyRoom(p); }
    this.syncView();
  }

  // ---------- vòng lặp ----------
  update(dt: number): void {
    this.handleKeys(dt);
    this.edgeRotate(dt);
    if (this.wheelPending !== 0) {
      if (!this.myTurn) this.wheelPending = 0;
      else {
        const d = Math.abs(this.wheelPending) < 1e-4 ? this.wheelPending : this.wheelPending * (1 - Math.exp(-dt * 16));
        this.wheelPending -= d;
        this.rotate(d);
      }
    }
    this.updateStroke(dt);
    this.updateReplay(dt);
    this.updateCue(dt);
    this.updateHud();
    this.sendAim();
  }

  private updateStroke(dt: number): void {
    const s = this.stroke;
    if (!s) return;
    s.t += dt;
    const p = s.params;
    const c = s.start[0];
    const k = Math.min(1, s.t / STROKE_TIME);
    const pull = PULL_MAX * p.power * (1 - k * k) - 0.03 * k;
    this.scene.setCue({ visible: true, x: c.x, y: c.y, dx: p.dx, dy: p.dy, pull, spinX: p.spinX, spinY: p.spinY });
    this.scene.setGuide({ visible: false, x: 0, y: 0, dx: 1, dy: 0 });
    if (k >= 1) {
      this.stroke = null;
      this.afterglow = 0.35;
      this.startSim(s);
    }
  }

  private updateReplay(dt: number): void {
    const r = this.replay;
    if (!r || r.done) return;
    const sim = r.sim;
    // Phát lại bám theo đồng hồ thật: thời gian mô phỏng luôn = thời gian đã trôi qua kể từ lúc chạm bi.
    // Khung hình nào bị chậm thì bước bù ngay ở khung sau, nên tốc độ bi trên màn hình luôn đúng với vật lý
    // (trước đây mỗi khung chỉ chạy tối đa 50 ms nên máy bị khựng là bi chậm hẳn lại rồi mới nhanh lên).
    const now = performance.now();
    const target = (now - r.t0) / 1000;
    // Trễ quá 1 giây (tab bị ẩn / cửa sổ bị che nên trình duyệt hãm khung hình): tua thẳng tới hiện tại
    // để người chơi quay lại thấy ngay bàn đúng, không phải xem bi lăn chậm dần trong khi đồng hồ lượt vẫn chạy.
    const catchUp = target - sim.time > 1;
    let steps = 0;
    while (sim.time < target) {
      sim.step();
      steps++;
      if (!sim.moving || sim.time > 70) { r.done = true; break; }
    }
    this.scene.updateFromSim(sim.balls, steps * DT);
    let sounds = catchUp ? 5 : 0; // không phát dồn tiếng va chạm của đoạn đã tua qua
    while (r.eventIdx < sim.events.length) {
      const e = sim.events[r.eventIdx++];
      if (e.type === 'pocket') { this.scene.startSink(e.ball, e.pocket); if (!catchUp) playPocket(); }
      else if (sounds < 5) {
        sounds++;
        if (e.type === 'ball') playBall(e.speed); else playCushion(e.speed);
      }
    }
    if (r.done && r.msg) this.finishReplay(r.msg);
  }

  private updateCue(dt: number): void {
    const g = this.g;
    if (this.stroke) return;
    const hide = () => {
      this.scene.setCue({ visible: false, x: 0, y: 0, dx: 1, dy: 0, pull: 0, spinX: 0, spinY: 0 });
      this.scene.setGuide({ visible: false, x: 0, y: 0, dx: 1, dy: 0 });
    };
    if (this.replay) {
      if (this.afterglow > 0) {
        this.afterglow -= dt;
        const p = this.replay.params;
        const c = this.replay.start[0];
        this.scene.setCue({ visible: true, x: c.x, y: c.y, dx: p.dx, dy: p.dy, pull: -0.03 + (0.35 - this.afterglow) * 0.4, spinX: p.spinX, spinY: p.spinY });
      } else hide();
      return;
    }
    if (!g || (g.phase !== 'break' && g.phase !== 'play') || !this.room?.seats[0] || !this.room?.seats[1]) { hide(); return; }
    const cueBall = g.balls[0];
    if (cueBall.pocketed) { hide(); return; }

    if (this.myTurn) {
      const inHand = g.inHand !== 'none';
      const cx = inHand ? this.cuePos.x : cueBall.x;
      const cy = inHand ? this.cuePos.y : cueBall.y;
      if (inHand) this.scene.setBall(0, cx, cy);
      if (this.placing) {
        hide();
      } else {
        this.scene.setCue({ visible: true, x: cx, y: cy, dx: this.dir.x, dy: this.dir.y, pull: this.power * PULL_MAX, spinX: this.spin.x, spinY: this.spin.y });
        this.scene.setGuide({ visible: true, x: cx, y: cy, dx: this.dir.x, dy: this.dir.y });
      }
      this.scene.showPocket(g.onEight ? this.called : null);
    } else {
      // xem đối thủ ngắm
      const a = this.remote;
      const s = this.remoteS;
      const inHand = g.inHand !== 'none' && a?.cx !== undefined;
      if (a) {
        const k = 1 - Math.exp(-dt * 14);
        s.dx += (a.dx - s.dx) * k; s.dy += (a.dy - s.dy) * k;
        s.power += (a.power - s.power) * k;
        s.spinX = a.spinX; s.spinY = a.spinY;
        s.cx = a.cx ?? cueBall.x; s.cy = a.cy ?? cueBall.y;
        if (inHand) this.scene.setBall(0, s.cx, s.cy);
      }
      this.scene.setCue({ visible: !!a, x: inHand ? s.cx : cueBall.x, y: inHand ? s.cy : cueBall.y, dx: s.dx, dy: s.dy, pull: s.power * PULL_MAX, spinX: s.spinX, spinY: s.spinY });
      this.scene.setGuide({ visible: false, x: 0, y: 0, dx: 1, dy: 0 });
      this.scene.showPocket(g.onEight && a && typeof a.calledPocket === 'number' ? a.calledPocket : null);
    }
  }

  private updateHud(): void {
    const g = this.g;
    const room = this.room;
    if (!room || !g) { this.ui.setPowerEnabled(false); this.ui.setTimer(null); return; }
    this.ui.setPowerEnabled(this.myTurn && !this.placing);
    this.ui.showReplace(this.myTurn && g.inHand !== 'none' && !this.placing);

    if (g.phase === 'over' || !room.seats[0] || !room.seats[1] || this.deadline === null) this.ui.setTimer(null);
    else {
      const sec = Math.min(TURN_SECONDS, Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000)));
      this.ui.setTimer(sec);
      if (this.myTurn && sec <= 5 && sec > 0 && sec !== this.lastTick) { this.lastTick = sec; playTick(); }
    }

    if (this.myTurn && g.onEight && !this.placing) {
      this.ui.setPocketButtons([0, 1, 2, 3, 4, 5].map((i) => this.scene.pocketScreen(i)), this.called);
    } else this.ui.setPocketButtons([]);

    let hint = '';
    if (!room.seats[0] || !room.seats[1] || g.phase === 'over' || this.busy) hint = '';
    else if (room.you === null) hint = 'Bạn đang xem trận đấu';
    else if (g.phase === 'choice') hint = g.turn === room.you ? '' : room.practice ? '🤖 Máy đang chọn…' : 'Đối thủ đang chọn…';
    else if (g.turn !== room.you) hint = room.practice ? (this.remote ? '🤖 Máy đang ngắm…' : '🤖 Máy đang tính cú đánh…') : 'Đối thủ đang ngắm…';
    else if (this.placing) hint = g.inHand === 'kitchen' ? '👆 Bấm để đặt bi cái phía sau vạch trắng' : '👆 Bấm để đặt bi cái ở bất kỳ đâu';
    else if (g.onEight && this.called === null) hint = '🎯 Bấm vào lỗ bạn muốn đánh bi số 8 vào';
    else if (this.spinDrag) hint = 'Rê chuột để dời điểm đánh · thả chuột phải là xong';
    else if (this.spinPinned) hint = 'Bấm vào bi lớn để chọn điểm đánh · bấm ra ngoài hoặc Esc để đóng';
    else if (this.powerDrag) hint = 'Kéo xa hơn = mạnh hơn · thả chuột để đánh · chuột phải / Esc để huỷ';
    else if (this.scene.view === 'cue') hint = '🖱️ Rê/lăn chuột xoay cơ · giữ trái kéo ra xa, thả để đánh · chuột phải: điểm đánh';
    else hint = '🖱️ Di chuột ngắm · giữ trái kéo ra xa, thả để đánh · chuột phải: điểm đánh';
    this.ui.setHint(hint);
  }

  private sendAim(): void {
    const g = this.g;
    if (!this.myTurn || !g) return;
    const now = performance.now();
    if (now - this.lastSent < 70) return;
    const msg: AimMsg = { dx: this.dir.x, dy: this.dir.y, power: this.power, spinX: this.spin.x, spinY: this.spin.y };
    if (g.inHand !== 'none') { msg.cx = this.cuePos.x; msg.cy = this.cuePos.y; }
    if (g.onEight && this.called !== null) msg.calledPocket = this.called;
    const key = JSON.stringify(msg);
    if (key === this.lastSentKey && now - this.lastSent < 1000) return;
    this.lastSentKey = key;
    this.lastSent = now;
    this.socket.emit('aim', msg);
  }

  // ---------- điều khiển ----------
  setView(mode: ViewMode): void {
    this.preferredView = mode;
    this.ui.setViewActive(mode);
    // đang xem bi chạy thì giữ toàn cảnh (đổi sau khi bi dừng); "Sau gậy" chỉ áp dụng khi đang chơi
    if (this.replay && mode === 'cue') return;
    if (mode !== 'cue' || this.busy) this.scene.setView(mode);
    else this.syncView();
  }

  /** Góc nhìn sau gậy: chuột nằm sát mép trái/phải thì cơ tự xoay tiếp (xoay được trọn 360°). */
  private edgeRotate(dt: number): void {
    const h = this.hover;
    let target = 0;
    if (h && this.scene.view === 'cue' && this.myTurn && !this.placing && !this.powerDrag && !this.spinDrag && !this.spinPinned) {
      const w = window.innerWidth;
      const left = 110, right = 180; // bên phải chừa chỗ cho thanh lực
      let depth = 0;
      if (h.x < left) depth = (left - h.x) / left;
      else if (h.x > w - right) depth = -(h.x - (w - right)) / (right - 70);
      if (depth === 0) h.since = performance.now();
      else if (performance.now() - h.since >= 150) { // tránh xoay khi chỉ lướt chuột qua mép
        const fine = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
        target = Math.max(-1, Math.min(1, depth)) * (fine ? 0.25 : 1.6);
      }
    }
    // tăng/giảm tốc độ dần (~0.15 s) để bắt đầu/dừng xoay không bị giật
    this.edgeVel += (target - this.edgeVel) * (1 - Math.exp(-dt * 10));
    if (Math.abs(this.edgeVel) < 0.002 && target === 0) { this.edgeVel = 0; return; }
    if (this.myTurn) this.rotate(this.edgeVel * dt);
  }

  setSpin(x: number, y: number): void {
    if (!this.myTurn) return;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    this.spin = { x, y };
    this.ui.setSpinDot(x, y);
  }

  closeSpinBig(): void {
    this.spinPinned = false;
    this.spinDrag = null;
    this.ui.hideSpinBig();
  }

  callPocket(i: number): void {
    if (!this.myTurn) return;
    this.called = i;
  }

  replace(): void {
    if (this.myTurn) this.placing = true;
  }

  /** Thanh lực bên phải (dành cho màn hình cảm ứng). */
  powerDragBar(p: number, release: boolean): void {
    if (!this.myTurn || this.placing) return;
    unlockAudio();
    this.power = Math.min(1, Math.max(0, p));
    this.ui.setPower(this.power);
    if (release) {
      if (this.power > 0.03) this.fire();
      else { this.power = 0; this.ui.setPower(0); }
    }
  }

  private cancelPower(): void {
    this.powerDrag = null;
    this.charging = false;
    this.power = 0;
    this.ui.setPower(0);
    this.ui.setPowerTip(null);
  }

  private fire(): void {
    const g = this.g;
    if (!g || !this.myTurn) return;
    this.ui.setPowerTip(null);
    if (this.placing) { this.ui.toast('Hãy đặt bi cái trước'); return; }
    if (g.onEight && this.called === null) {
      this.ui.toast('Hãy chọn lỗ cho bi số 8 trước');
      this.cancelPower();
      return;
    }
    const inHand = g.inHand !== 'none';
    const params: ShotParams = { dx: this.dir.x, dy: this.dir.y, power: this.power, spinX: this.spin.x, spinY: this.spin.y };
    const start = g.balls.map((b) => ({ ...b }));
    if (inHand) start[0] = { ...start[0], x: this.cuePos.x, y: this.cuePos.y, pocketed: false };
    // chạy trước ngay trên máy mình (engine giống hệt server) để không phải chờ mạng
    this.localShot = true;
    this.beginStroke({ start, params, msg: null });
    const input = {
      params,
      cuePos: inHand ? { ...this.cuePos } : undefined,
      calledPocket: g.onEight && this.called !== null ? this.called : undefined,
    };
    void ask(this.socket, 'shot', input).then((r) => { if (!r.ok) this.abortLocal(r.error); });
  }

  private aimAt(p: { x: number; y: number }): void {
    const g = this.g;
    if (!g) return;
    const cx = g.inHand !== 'none' ? this.cuePos.x : g.balls[0].x;
    const cy = g.inHand !== 'none' ? this.cuePos.y : g.balls[0].y;
    const dx = p.x - cx, dy = p.y - cy;
    const l = Math.hypot(dx, dy);
    if (l < 0.04) return;
    this.dir = { x: dx / l, y: dy / l };
  }

  private rotate(delta: number): void {
    const a = Math.atan2(this.dir.y, this.dir.x) + delta;
    this.dir = { x: Math.cos(a), y: Math.sin(a) };
  }

  private clampPlacement(p: { x: number; y: number }): { x: number; y: number } {
    const g = this.g;
    const m = BALL_R + 0.003;
    const maxX = g?.inHand === 'kitchen' ? HEAD_STRING_X : TABLE_L - m;
    return { x: Math.min(maxX, Math.max(m, p.x)), y: Math.min(TABLE_W - m, Math.max(m, p.y)) };
  }

  private onTable(p: { x: number; y: number } | null): p is { x: number; y: number } {
    return !!p && p.x > -0.25 && p.x < TABLE_L + 0.25 && p.y > -0.25 && p.y < TABLE_W + 0.25;
  }

  private bindInput(): void {
    const cv = this.canvas;
    const powerPx = () => Math.min(380, Math.max(180, Math.min(window.innerWidth, window.innerHeight) * 0.4));
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    cv.addEventListener('pointerdown', (e) => {
      unlockAudio();
      if (e.pointerType === 'touch') this.touches.add(e.pointerId);
      if (this.powerDrag && e.button === 2) { this.cancelPower(); return; }
      // đang mở bảng điểm đánh lớn: bấm ra ngoài là đóng
      if (this.spinPinned) { this.closeSpinBig(); return; }
      // chuột phải: chỉnh điểm đánh (giữ + rê để dời, bấm nhanh để mở bảng lớn)
      if (e.button === 2 && e.pointerType === 'mouse') {
        if (!this.myTurn || this.placing) return;
        cv.setPointerCapture(e.pointerId);
        this.spinDrag = { x: e.clientX, y: e.clientY, sx: this.spin.x, sy: this.spin.y, moved: false, id: e.pointerId };
        this.ui.showSpinBig(e.clientX, e.clientY);
        return;
      }
      if (e.button !== 0 || this.touches.size > 1 || !this.myTurn) return;
      const g = this.g!;
      if (this.placing) {
        const p = this.scene.pick(e.clientX, e.clientY);
        if (!p) return;
        const c = this.clampPlacement(p);
        this.cuePos = c;
        if (validCuePos(g.balls, c, g.inHand)) this.placing = false;
        else this.ui.toast('Không thể đặt bi cái ở đây');
        return;
      }
      cv.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        // cảm ứng: một ngón kéo để ngắm, lực dùng thanh bên phải
        this.aimDrag = e.pointerId;
        if (this.scene.view !== 'cue') { const p = this.scene.pick(e.clientX, e.clientY); if (this.onTable(p)) this.aimAt(p); }
        return;
      }
      // chuột: nhấn giữ + kéo ra xa để lấy lực, thả để đánh (hướng ngắm được khoá)
      this.powerDrag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      this.power = 0;
      this.ui.setPower(0);
      this.ui.setPowerTip({ x: e.clientX, y: e.clientY, p: 0 });
    });

    cv.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') {
        if (!this.hover) this.hover = { x: e.clientX, y: e.clientY, since: performance.now() };
        this.hover.x = e.clientX; this.hover.y = e.clientY;
      }
      if (this.spinDrag) {
        // rê 85px = từ tâm ra mép bi (độ lệch tối đa)
        const dx = e.clientX - this.spinDrag.x, dy = e.clientY - this.spinDrag.y;
        if (Math.hypot(dx, dy) > 5) this.spinDrag.moved = true;
        this.setSpin(this.spinDrag.sx + dx / 85, this.spinDrag.sy - dy / 85);
        return;
      }
      if (this.powerDrag) {
        if (e.buttons & 2) { this.cancelPower(); return; }
        const d = Math.hypot(e.clientX - this.powerDrag.x, e.clientY - this.powerDrag.y);
        this.power = Math.min(1, d / powerPx());
        this.ui.setPower(this.power);
        this.ui.setPowerTip({ x: e.clientX, y: e.clientY, p: this.power });
        return;
      }
      if (!this.myTurn || this.touches.size > 1) return;
      if (this.placing) {
        const p = this.scene.pick(e.clientX, e.clientY);
        if (p) this.cuePos = this.clampPlacement(p);
        return;
      }
      if (this.scene.view === 'cue') {
        // góc nhìn sau gậy: rê chuột trái/phải (hoặc kéo một ngón) để xoay cơ quanh bi cái;
        // đưa chuột sát mép màn hình thì cơ tự xoay tiếp (xem edgeRotate)
        if (e.buttons & 4) return; // đang giữ con lăn
        if (e.pointerType === 'mouse' || this.aimDrag === e.pointerId) this.rotate(-e.movementX * (e.shiftKey ? 0.0004 : 0.0022));
        return;
      }
      if (e.buttons & 4) return; // đang giữ con lăn để xoay camera
      if (e.pointerType === 'mouse' || this.aimDrag === e.pointerId) {
        const p = this.scene.pick(e.clientX, e.clientY);
        if (this.onTable(p)) this.aimAt(p);
      }
    });

    const end = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.spinDrag && this.spinDrag.id === e.pointerId) {
        // rê xong thì đóng; bấm nhanh (không rê) thì để bảng lớn mở cho bấm chọn bằng chuột trái
        if (this.spinDrag.moved || e.type !== 'pointerup') this.ui.hideSpinBig();
        else this.spinPinned = true;
        this.spinDrag = null;
        return;
      }
      if (this.aimDrag === e.pointerId) this.aimDrag = null;
      if (this.powerDrag && this.powerDrag.id === e.pointerId) {
        this.powerDrag = null;
        this.ui.setPowerTip(null);
        if (e.type === 'pointerup' && this.power > 0.03 && this.myTurn) this.fire();
        else this.cancelPower();
      }
    };
    cv.addEventListener('pointerup', end);
    // chuột rời canvas (sang bảng điều khiển / ra ngoài cửa sổ) thì không tự xoay nữa
    cv.addEventListener('pointerleave', () => { this.hover = null; });
    // góc nhìn sau gậy: lăn chuột để xoay cơ (mỗi nấc ~2°, giữ Shift ~0.3°)
    cv.addEventListener('wheel', (e) => {
      if (this.scene.view !== 'cue' || !this.myTurn || this.placing) return;
      e.preventDefault();
      const step = e.shiftKey ? 0.005 : 0.035;
      this.wheelPending += -Math.sign(e.deltaY || e.deltaX) * step;
    }, { passive: false });
    cv.addEventListener('pointercancel', end);

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat && this.myTurn && !this.placing) { this.charging = true; this.power = 0.02; unlockAudio(); }
        return;
      }
      if (e.code === 'Escape') { this.cancelPower(); this.closeSpinBig(); return; }
      if (e.code === 'Digit1') this.setView('angled');
      else if (e.code === 'Digit2') this.setView('top');
      else if (e.code === 'Digit3') this.setView('cue');
      else if (e.code === 'KeyW') this.setSpin(this.spin.x, Math.min(1, this.spin.y + 0.25));
      else if (e.code === 'KeyS') this.setSpin(this.spin.x, Math.max(-1, this.spin.y - 0.25));
      else if (e.code === 'KeyA') this.setSpin(Math.max(-1, this.spin.x - 0.25), this.spin.y);
      else if (e.code === 'KeyD') this.setSpin(Math.min(1, this.spin.x + 0.25), this.spin.y);
      else if (e.code === 'KeyX') this.setSpin(0, 0);
      else this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space' && this.charging) {
        this.charging = false;
        if (this.myTurn && this.power > 0.03) this.fire(); else this.cancelPower();
      }
    });
    window.addEventListener('blur', () => {
      this.closeSpinBig(); this.keys.clear(); if (this.charging || this.powerDrag) this.cancelPower(); });
  }

  private handleKeys(dt: number): void {
    if (!this.myTurn) return;
    const fine = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const rate = fine ? 0.08 : 0.6;
    if (this.keys.has('ArrowLeft')) this.rotate(rate * dt);
    if (this.keys.has('ArrowRight')) this.rotate(-rate * dt);
    if (this.keys.has('ArrowUp')) { this.power = Math.min(1, this.power + dt * 0.5); this.ui.setPower(this.power); }
    if (this.keys.has('ArrowDown')) { this.power = Math.max(0, this.power - dt * 0.5); this.ui.setPower(this.power); }
    if (this.charging) {
      this.power = Math.min(1, this.power + dt * 0.75);
      this.ui.setPower(this.power);
    }
  }
}
