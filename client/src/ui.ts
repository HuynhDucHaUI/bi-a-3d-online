// Giao diện DOM: sảnh, HUD, hộp thoại, chat.
import { AI_LEVEL_NAME, AiLevel } from '@shared/ai';
import type { Choice, GameView, Group } from '@shared/game';
import type { ChatMsg, RoomView } from '@shared/protocol';
import { BALL_COLORS } from './render/textures';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface UiHandlers {
  quick(name: string): void;
  create(name: string, isPublic: boolean): void;
  practice(name: string, level: AiLevel): void;
  join(name: string, code: string, spectate: boolean): void;
  leave(): void;
  view(mode: 'angled' | 'top' | 'cue'): void;
  spin(x: number, y: number): void;
  /** bảng điểm đánh lớn vừa đóng (người dùng chọn xong) */
  spinClosed(): void;
  powerDrag(p: number, release: boolean): void;
  replace(): void;
  call(pocket: number): void;
  choice(c: Choice): void;
  rematch(): void;
  chat(text: string): void;
  mute(): boolean;
  quality(): void;
}

const GROUP_NAME: Record<Group, string> = { solids: 'Bi trơn (1-7)', stripes: 'Bi sọc (9-15)' };
const GROUP_IDS: Record<Group, number[]> = { solids: [1, 2, 3, 4, 5, 6, 7], stripes: [9, 10, 11, 12, 13, 14, 15] };

export class Ui {
  h!: UiHandlers;
  private modalKey = '';
  private bannerTimer = 0;
  private toastTimer = 0;
  private unread = 0;
  private hintText = '';
  private timerText = '';
  /** đang luyện tập với máy (không có mã mời) */
  private practice = false;

  init(h: UiHandlers): void {
    this.h = h;
    const name = $<HTMLInputElement>('nameInput');
    const code = $<HTMLInputElement>('codeInput');
    const getName = () => name.value.trim();
    $('btnQuick').onclick = () => h.quick(getName());
    $('btnCreate').onclick = () => h.create(getName(), $<HTMLInputElement>('chkPublic').checked);
    $('btnJoin').onclick = () => h.join(getName(), code.value, false);
    $('btnWatch').onclick = () => h.join(getName(), code.value, true);
    document.querySelectorAll<HTMLButtonElement>('#levels .btn').forEach((b) => {
      b.onclick = () => h.practice(getName(), b.dataset.level as AiLevel);
    });
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') h.join(getName(), code.value, false); });
    $('btnLeave').onclick = () => {
      // bấm nhầm "Đầu hàng" là thua ván ngay: hỏi lại cho chắc
      if ($('btnLeave').textContent === 'Đầu hàng' && !window.confirm('Đầu hàng và rời phòng? Bạn sẽ bị xử thua ván này.')) return;
      h.leave();
    };
    $('btnReplace').onclick = () => h.replace();
    $('btnMute').onclick = () => { $('btnMute').textContent = h.mute() ? '🔇' : '🔊'; };
    $('roomTag').onclick = () => { if (!this.practice) this.copyInvite(); };
    // Nút trong HUD không giữ tiêu điểm bàn phím sau khi bấm: nếu giữ, nhấn Enter/Space lúc chơi
    // sẽ "bấm lại" nút đó (vd. vừa đóng chat lại tự mở ra).
    $('hud').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b) b.blur();
    });
    $('btnHelp').onclick = () => this.showControlsHelp(true);
    $('btnQuality').onclick = () => h.quality();
    const closeHelp = () => {
      $('help').hidden = true;
      try { localStorage.setItem('bia.help', '1'); } catch { /* bỏ qua */ }
    };
    $('btnHelpOk').onclick = closeHelp;
    // bấm ra ngoài bảng hoặc nhấn Esc cũng đóng (màn hình thấp có thể không thấy nút)
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) closeHelp(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('help').hidden) closeHelp(); });

    document.querySelectorAll<HTMLButtonElement>('#viewSeg .btn').forEach((b) => {
      b.onclick = () => h.view(b.dataset.view as any);
    });

    // bảng chọn điểm đánh xoáy
    const spin = $('spin');
    const setSpin = (e: PointerEvent) => {
      const r = spin.getBoundingClientRect();
      let x = ((e.clientX - r.left) / r.width) * 2 - 1;
      let y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      if (m < 0.12) { x = 0; y = 0; }
      h.spin(x, y);
    };
    spin.addEventListener('pointerdown', (e) => { spin.setPointerCapture(e.pointerId); setSpin(e); });
    spin.addEventListener('pointermove', (e) => { if (spin.hasPointerCapture(e.pointerId)) setSpin(e); });

    // bảng điểm đánh lớn (mở bằng chuột phải): bấm/kéo chuột trái trên bi để chọn, thả ra là xong
    const big = $('spinBigBall');
    const setBig = (e: PointerEvent) => {
      const r = big.getBoundingClientRect();
      let x = ((e.clientX - r.left) / r.width) * 2 - 1;
      let y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      if (m < 0.08) { x = 0; y = 0; }
      h.spin(x, y);
    };
    big.addEventListener('contextmenu', (e) => e.preventDefault());
    big.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; big.setPointerCapture(e.pointerId); setBig(e); });
    big.addEventListener('pointermove', (e) => { if (big.hasPointerCapture(e.pointerId)) setBig(e); });
    big.addEventListener('pointerup', (e) => {
      if (!big.hasPointerCapture(e.pointerId)) return;
      big.releasePointerCapture(e.pointerId);
      this.hideSpinBig();
      h.spinClosed();
    });

    // thanh lực
    const track = $('powerTrack');
    const fromEvent = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    };
    track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); h.powerDrag(fromEvent(e), false); });
    track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) h.powerDrag(fromEvent(e), false); });
    const up = (e: PointerEvent) => { if (track.hasPointerCapture(e.pointerId)) { track.releasePointerCapture(e.pointerId); h.powerDrag(fromEvent(e), true); } };
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', () => h.powerDrag(0, false));

    // chat
    const chat = $('chat');
    $('chatToggle').onclick = () => {
      chat.classList.toggle('open');
      if (chat.classList.contains('open')) { this.unread = 0; this.renderBadge(); $<HTMLInputElement>('chatInput').focus(); }
    };
    $<HTMLInputElement>('chatInput').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const inp = e.target as HTMLInputElement;
        if (inp.value.trim()) h.chat(inp.value);
        inp.value = '';
      }
    });

    if (!name.value) name.value = localStorage.getItem('bia.name') ?? '';
  }

  get nameValue(): string {
    return $<HTMLInputElement>('nameInput').value.trim();
  }

  setName(n: string): void {
    $<HTMLInputElement>('nameInput').value = n;
  }

  setCode(c: string): void {
    $<HTMLInputElement>('codeInput').value = c.toUpperCase();
  }

  // ---------- màn hình ----------
  get inLobby(): boolean {
    return !$('lobby').hidden;
  }

  showLobby(error = ''): void {
    $('lobby').hidden = false;
    $('hud').hidden = true;
    this.hideModal();
    this.setPocketButtons([]);
    $('lobbyError').textContent = error;
  }

  showHud(): void {
    $('lobby').hidden = true;
    $('hud').hidden = false;
  }

  lobbyBusy(b: boolean): void {
    for (const id of ['btnQuick', 'btnCreate', 'btnJoin', 'btnWatch']) $<HTMLButtonElement>(id).disabled = b;
    document.querySelectorAll<HTMLButtonElement>('#levels .btn').forEach((el) => { el.disabled = b; });
  }

  setOnline(online: boolean): void {
    $('conn').hidden = online;
  }

  toast(text: string): void {
    const t = $('toast');
    t.textContent = text;
    t.classList.toggle('ok', text.startsWith('✅'));
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
  }

  banner(text: string, bad = false): void {
    const b = $('banner');
    b.textContent = text;
    b.classList.toggle('bad', bad);
    b.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), 3200);
  }

  setHint(text: string): void {
    if (text === this.hintText) return;
    this.hintText = text;
    $('hint').textContent = text;
    $('hint').hidden = !text;
  }

  setTimer(sec: number | null): void {
    const text = sec === null ? '--' : String(sec);
    if (text === this.timerText) return;
    this.timerText = text;
    const t = $('timer');
    t.textContent = text;
    t.classList.toggle('low', sec !== null && sec <= 10);
  }

  /** Nhãn % lực đi theo con trỏ khi đang kéo để lấy lực. */
  setPowerTip(t: { x: number; y: number; p: number } | null): void {
    const el = $('powerTip');
    if (!t) { el.hidden = true; return; }
    el.hidden = false;
    el.style.left = `${t.x}px`;
    el.style.top = `${t.y}px`;
    const pct = Math.round(t.p * 100);
    el.textContent = pct === 0 ? 'Kéo ra xa để lấy lực' : `Lực ${pct}%`;
    el.style.setProperty('--p', String(t.p));
  }

  setQuality(q: 'high' | 'low', gpu: string): void {
    const b = $('btnQuality');
    b.textContent = q === 'high' ? '⚙️ Cao' : '⚙️ Nhẹ';
    b.title = `Đồ họa ${q === 'high' ? 'Cao' : 'Nhẹ'} – bấm để đổi (tải lại trang). Card đồ họa: ${gpu || 'không rõ'}`;
  }

  /** Hướng dẫn cách đánh: hiện ở lượt đầu tiên (một lần). */
  showControlsHelp(force = false): void {
    let seen = false;
    try { seen = localStorage.getItem('bia.help') === '1'; } catch { /* bỏ qua */ }
    if (seen && !force) return;
    $('help').hidden = false;
  }

  // ---------- điều khiển ----------
  setPower(p: number): void {
    const track = $('powerTrack');
    const h = track.clientHeight;
    $('powerCover').style.height = `${p * 100}%`;
    $('powerHandle').style.top = `${p * h}px`;
    $('powerVal').textContent = `${Math.round(p * 100)}%`;
  }

  setPowerEnabled(on: boolean): void {
    $('power').classList.toggle('disabled', !on);
  }

  setSpinDot(x: number, y: number): void {
    for (const id of ['spinDot', 'spinBigDot']) {
      const d = $(id);
      d.style.left = `${50 + x * 50}%`;
      d.style.top = `${50 - y * 50}%`;
    }
    let text = 'Giữa bi';
    if (x !== 0 || y !== 0) {
      const parts: string[] = [];
      if (y > 0.2) parts.push('đuổi'); else if (y < -0.2) parts.push('giật');
      if (x > 0.2) parts.push('phải'); else if (x < -0.2) parts.push('trái');
      text = parts.join(' + ') || 'Giữa bi';
    }
    $('spinText').textContent = text;
    $('spinBigText').textContent = text;
  }

  /** Bảng điểm đánh lớn ngay tại con trỏ (giữ trong màn hình). */
  showSpinBig(x: number, y: number): void {
    const el = $('spinBig');
    const r = 105;
    el.style.left = `${Math.min(window.innerWidth - r, Math.max(r, x))}px`;
    el.style.top = `${Math.min(window.innerHeight - r - 30, Math.max(r, y))}px`;
    el.hidden = false;
  }

  hideSpinBig(): void {
    $('spinBig').hidden = true;
  }

  setViewActive(mode: string): void {
    document.querySelectorAll<HTMLButtonElement>('#viewSeg .btn').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
  }

  showReplace(on: boolean): void {
    $('btnReplace').hidden = !on;
  }

  /** Nút chọn lỗ khi đánh bi 8. positions: toạ độ màn hình của 6 lỗ. */
  setPocketButtons(positions: { x: number; y: number }[], selected: number | null = null): void {
    const box = $('pocketBtns');
    if (positions.length === 0) { if (box.childElementCount) box.innerHTML = ''; return; }
    if (box.childElementCount !== positions.length) {
      box.innerHTML = '';
      positions.forEach((_, i) => {
        const b = document.createElement('button');
        b.className = 'pbtn';
        b.textContent = '8';
        b.onclick = () => this.h.call(i);
        box.appendChild(b);
      });
    }
    positions.forEach((p, i) => {
      const b = box.children[i] as HTMLElement;
      b.style.left = `${p.x}px`;
      b.style.top = `${p.y}px`;
      b.classList.toggle('sel', selected === i);
    });
  }

  // ---------- đồng bộ phòng ----------
  sync(room: RoomView, finished: boolean): void {
    this.showHud();
    const g = room.game;
    this.practice = !!room.practice;
    const watchers = room.spectators ? ` · ${room.spectators} người xem` : '';
    $('roomTag').textContent = room.practice ? `🤖 Luyện tập · ${AI_LEVEL_NAME[room.practice]}${watchers}` : `Phòng ${room.code}${watchers}`;
    $('roomTag').title = room.practice ? `Mã phòng ${room.code} (người khác có thể vào xem)` : 'Bấm để sao chép liên kết mời';
    for (const i of [0, 1] as const) this.renderPlayer(room, i);
    $('msgLine').textContent = g ? g.message : 'Đang chờ đối thủ…';
    $('msgLine').hidden = !g;
    // luyện tập: thoát là xong, không tính thua nên không cần hỏi "Đầu hàng"
    $('btnLeave').textContent = room.you === null || room.practice ? 'Thoát' : g && g.phase !== 'over' && room.seats[0] && room.seats[1] ? 'Đầu hàng' : 'Thoát';
    this.renderModal(room, finished);
  }

  private renderPlayer(room: RoomView, i: 0 | 1): void {
    const el = $(`p${i}`);
    const p = room.seats[i];
    const g = room.game;
    const active = !!g && g.phase !== 'over' && g.turn === i && !!room.seats[0] && !!room.seats[1];
    el.classList.toggle('active', active);
    el.classList.toggle('off', !p || !p.connected);
    const bot = !!room.practice && i === 1;
    (el.querySelector('.avatar') as HTMLElement).textContent = bot ? '🤖' : p ? p.name.slice(0, 1).toUpperCase() : '?';
    const nm = el.querySelector('.pname') as HTMLElement;
    nm.innerHTML = '';
    nm.append(p ? p.name + (room.you === i ? ' (bạn)' : '') + (p.connected ? '' : ' · mất kết nối') : 'Đang chờ…');
    if (p && room.seats[0] && room.seats[1]) {
      const sc = document.createElement('span');
      sc.className = 'score';
      sc.textContent = String(room.scores[i]);
      nm.append(sc);
    }
    const grp = el.querySelector('.pgroup') as HTMLElement;
    const tray = el.querySelector('.tray') as HTMLElement;
    tray.innerHTML = '';
    if (!g || !p) { grp.textContent = ''; return; }
    const group = g.groups[i];
    if (g.phase === 'over' && g.winner === i) grp.textContent = '🏆 Thắng';
    else if (group) {
      grp.textContent = g.onEight && g.turn === i ? 'Đánh bi số 8' : GROUP_NAME[group];
      const live = new Set(g.balls.filter((b) => !b.pocketed).map((b) => b.id));
      for (const id of GROUP_IDS[group]) tray.append(miniBall(id, live.has(id)));
      tray.append(miniBall(8, live.has(8)));
    } else grp.textContent = g.phase === 'break' && g.breaker === i ? 'Phá bi' : 'Bàn mở';
  }

  private renderModal(room: RoomView, finished: boolean): void {
    const g = room.game;
    const bothSeated = !!room.seats[0] && !!room.seats[1];
    let key = '';
    let build: (() => HTMLElement) | null = null;

    if (!bothSeated && g && g.phase === 'over' && finished && room.you !== null) {
      // đối thủ đã rời phòng sau / giữa ván: báo kết quả + chờ người mới
      key = `left:${g.seq}:${room.code}`;
      build = () => this.leftCard(room, g);
    } else if (!bothSeated) {
      key = `wait:${room.code}:${room.you}`;
      build = () => this.waitingCard(room);
    } else if (g && g.phase === 'over' && finished) {
      key = `over:${g.seq}:${room.rematch.join('')}:${room.scores.join('-')}`;
      build = () => this.overCard(room, g);
    } else if (g && g.phase === 'choice' && finished && room.you === g.turn) {
      key = `choice:${g.seq}`;
      build = () => this.choiceCard(g);
    }

    if (key === this.modalKey) return;
    this.modalKey = key;
    const m = $('modal');
    if (!build) { m.hidden = true; m.innerHTML = ''; return; }
    m.innerHTML = '';
    m.appendChild(build());
    m.hidden = false;
  }

  hideModal(): void {
    this.modalKey = '';
    $('modal').hidden = true;
    $('modal').innerHTML = '';
  }

  private card(title: string, body: string): HTMLElement {
    const c = document.createElement('div');
    c.className = 'card';
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    c.append(h, p);
    return c;
  }

  private btn(text: string, onclick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'btn' + (primary ? ' primary' : '');
    b.textContent = text;
    b.onclick = onclick;
    return b;
  }

  private waitingCard(room: RoomView): HTMLElement {
    const c = this.card('Đang chờ đối thủ…', room.you === null ? 'Bạn đang xem phòng này.' : 'Gửi mã hoặc liên kết bên dưới cho bạn bè để cùng chơi.');
    const code = document.createElement('div');
    code.className = 'codeBig';
    code.textContent = room.code;
    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.append(this.inviteBox(room.code), this.btn('📋 Sao chép liên kết mời', () => this.copyInvite(), true), this.btn('Rời phòng', () => this.h.leave()));
    c.insertBefore(code, c.querySelector('p')!.nextSibling);
    c.append(stack);
    return c;
  }

  private overCard(room: RoomView, g: GameView): HTMLElement {
    let title = 'Kết thúc ván';
    if (room.you !== null) title = g.winner === room.you ? '🏆 Bạn thắng!' : 'Bạn thua';
    else if (g.winner !== null) title = `${room.seats[g.winner]?.name ?? 'Người chơi'} thắng`;
    const c = this.card(title, g.message);
    const score = document.createElement('p');
    score.innerHTML = `Tỉ số: <b>${esc(room.seats[0]?.name ?? '?')}</b> ${room.scores[0]} – ${room.scores[1]} <b>${esc(room.seats[1]?.name ?? '?')}</b>`;
    c.append(score);
    const stack = document.createElement('div');
    stack.className = 'stack';
    if (room.you !== null) {
      const waiting = room.rematch[room.you];
      const b = this.btn(waiting ? 'Đang chờ đối thủ…' : '🔁 Chơi lại', () => this.h.rematch(), true);
      b.disabled = waiting;
      stack.append(b);
    }
    stack.append(this.btn('Rời phòng', () => this.h.leave()));
    c.append(stack);
    return c;
  }

  private leftCard(room: RoomView, g: GameView): HTMLElement {
    const won = g.winner === room.you;
    const c = this.card(won ? '🏆 Bạn thắng!' : 'Kết thúc ván', g.message);
    const p = document.createElement('p');
    p.textContent = 'Đối thủ đã rời phòng. Bạn có thể mời người khác vào bằng mã:';
    const code = document.createElement('div');
    code.className = 'codeBig';
    code.textContent = room.code;
    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.append(this.inviteBox(room.code), this.btn('📋 Sao chép liên kết mời', () => this.copyInvite(), true), this.btn('Rời phòng', () => this.h.leave()));
    c.append(p, code, stack);
    return c;
  }

  private choiceCard(g: GameView): HTMLElement {
    const c = this.card('Đối thủ phá bi lỗi', g.message.replace(/\. Đối thủ chọn.*$/, '') + '. Bạn muốn làm gì?');
    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.append(
      this.btn('Nhận bàn và đánh tiếp', () => this.h.choice('accept'), true),
      this.btn('Xếp lại bi – tôi phá', () => this.h.choice('rerack-self')),
      this.btn('Xếp lại bi – đối thủ phá', () => this.h.choice('rerack-other')),
    );
    c.append(stack);
    return c;
  }

  private inviteUrl(code?: string): string {
    const c = code ?? document.getElementById('roomTag')?.textContent?.match(/Phòng (\w+)/)?.[1] ?? '';
    return `${location.origin}${location.pathname}?room=${c}`;
  }

  /**
   * Sao chép liên kết mời. Trang mở qua http://<IP> (không phải https/localhost) thì trình duyệt KHÔNG có
   * navigator.clipboard, nên dùng cách dự phòng (ô chữ ẩn + execCommand('copy')). Chỉ báo "đã sao chép" khi
   * sao chép thật sự thành công; nếu không, hiện liên kết để người chơi tự sao chép.
   */
  copyInvite(): void {
    const url = this.inviteUrl();
    const ok = () => this.toast('✅ Đã sao chép liên kết mời – dán (Ctrl+V) để gửi cho bạn bè');
    const fail = () => {
      this.toast('Trình duyệt chặn sao chép tự động – hãy bôi đen liên kết trong ô và nhấn Ctrl+C');
      const box = document.querySelector<HTMLInputElement>('#modal .inviteLink');
      if (box) { box.focus(); box.select(); }
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(ok, () => (legacyCopy(url) ? ok() : fail()));
    } else if (legacyCopy(url)) ok();
    else fail();
  }

  /** Ô chứa sẵn liên kết mời: bấm vào là bôi đen toàn bộ và tự sao chép. */
  private inviteBox(code: string): HTMLElement {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.readOnly = true;
    inp.className = 'inviteLink';
    inp.value = this.inviteUrl(code);
    inp.title = 'Bấm để chọn và sao chép liên kết';
    inp.addEventListener('click', () => { inp.select(); if (legacyCopy(inp.value)) this.toast('✅ Đã sao chép liên kết mời'); });
    return inp;
  }

  // ---------- chat ----------
  addChat(m: ChatMsg): void {
    const log = $('chatLog');
    const d = document.createElement('div');
    d.className = 'm';
    const b = document.createElement('b');
    b.textContent = m.name + ': ';
    d.append(b, document.createTextNode(m.text));
    log.append(d);
    log.scrollTop = log.scrollHeight;
    if (!$('chat').classList.contains('open')) { this.unread++; this.renderBadge(); }
  }

  addSystem(text: string): void {
    const log = $('chatLog');
    const d = document.createElement('div');
    d.className = 'm sys';
    d.textContent = text;
    log.append(d);
    log.scrollTop = log.scrollHeight;
  }

  clearChat(): void {
    $('chatLog').innerHTML = '';
    this.unread = 0;
    this.renderBadge();
  }

  private renderBadge(): void {
    const b = $('chatBadge');
    b.hidden = this.unread === 0;
    b.textContent = String(this.unread);
  }
}

function miniBall(id: number, stillOnTable: boolean): HTMLElement {
  const el = document.createElement('div');
  const c = BALL_COLORS[id > 8 ? id - 8 : id];
  el.className = 'mini' + (id > 8 ? ' stripe' : '') + (stillOnTable ? '' : ' in');
  el.style.setProperty('--c', c);
  if (id <= 8) el.style.background = c;
  const s = document.createElement('span');
  s.textContent = String(id);
  el.append(s);
  return el;
}

/** Sao chép kiểu cũ (chạy được cả trên trang http không bảo mật). */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;user-select:text;-webkit-user-select:text;';
  const prev = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  prev?.focus?.();
  return ok;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
