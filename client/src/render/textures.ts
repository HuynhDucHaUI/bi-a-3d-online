import * as THREE from 'three';

export const BALL_COLORS: Record<number, string> = {
  1: '#f2c500', 2: '#1747c4', 3: '#e0261c', 4: '#6a2a9c', 5: '#f07a10', 6: '#0e8a3c', 7: '#8a1c1c', 8: '#111111',
};

export const baseColor = (id: number): string => (id === 0 ? '#f6f4ec' : BALL_COLORS[id > 8 ? id - 8 : id]);

/** Texture bi (equirect): bi trơn, bi sọc, số. */
export function ballTexture(id: number): THREE.CanvasTexture {
  const w = 512, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const color = baseColor(id);
  if (id === 0) {
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    g.fillStyle = '#c33'; // chấm đỏ nhỏ để thấy bi xoay
    for (const u of [0.25, 0.75]) { g.beginPath(); g.arc(u * w, h / 2, 7, 0, Math.PI * 2); g.fill(); }
  } else {
    const stripe = id > 8;
    g.fillStyle = stripe ? '#f6f4ec' : color;
    g.fillRect(0, 0, w, h);
    if (stripe) { g.fillStyle = color; g.fillRect(0, h * 0.26, w, h * 0.48); }
    for (const u of [0.25, 0.75]) {
      g.fillStyle = '#f6f4ec';
      g.beginPath(); g.arc(u * w, h / 2, 34, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#111';
      g.font = 'bold 44px Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(id), u * w, h / 2 + 3);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function clothTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, s, s);
  const img = g.getImageData(0, 0, s, s);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 232 + Math.random() * 23;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 5); // UV tính theo mét
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

/** Vân gỗ cho thành bàn. */
export function woodTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 256);
  g.fillStyle = '#6b3519'; g.fillRect(0, 0, 1024, 256);
  for (let i = 0; i < 140; i++) {
    const y = Math.random() * 256;
    const amp = 2 + Math.random() * 6;
    const freq = 0.004 + Math.random() * 0.01;
    const ph = Math.random() * 10;
    g.strokeStyle = Math.random() < 0.5 ? `rgba(40,14,4,${0.08 + Math.random() * 0.25})` : `rgba(160,90,45,${0.05 + Math.random() * 0.15})`;
    g.lineWidth = 0.6 + Math.random() * 2.2;
    g.beginPath();
    for (let x = 0; x <= 1024; x += 16) g.lineTo(x, y + Math.sin(x * freq + ph) * amp);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.2, 4);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Bóng mềm hình tròn (đặt dưới bi). */
export function blobTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.35, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.7, 'rgba(0,0,0,0.15)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Bóng mềm dạng vệt dài (dưới gậy). */
export function lineShadowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(16, 64);
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.6)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 16, 64);
  return new THREE.CanvasTexture(c);
}

/** Sàn phòng: vùng sáng ấm dưới bàn, tối dần ra xa, có bóng bàn. */
export function floorTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 1024);
  g.fillStyle = '#0b0807'; g.fillRect(0, 0, 1024, 1024);
  const grd = g.createRadialGradient(512, 512, 40, 512, 512, 520);
  grd.addColorStop(0, '#4a3324');
  grd.addColorStop(0.45, '#2a1d15');
  grd.addColorStop(1, '#0b0807');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 1024);
  // ván sàn
  g.globalAlpha = 0.12;
  for (let x = 0; x < 1024; x += 32) { g.fillStyle = (x / 32) % 2 ? '#000' : '#7a5236'; g.fillRect(x, 0, 2, 1024); }
  g.globalAlpha = 1;
  // bóng bàn
  g.filter = 'blur(24px)';
  g.fillStyle = 'rgba(0,0,0,0.75)';
  g.fillRect(512 - 150, 512 - 82, 300, 164);
  g.filter = 'none';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Nền phòng (gradient dọc). */
export function backgroundTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(4, 256);
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#1d2420');
  grd.addColorStop(0.55, '#0e1210');
  grd.addColorStop(1, '#050605');
  g.fillStyle = grd; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Mặt nỉ với ánh sáng "nướng" sẵn (vùng sáng dưới đèn, mép tối dần) để không phải tính ánh sáng mỗi điểm ảnh.
 * w, h: kích thước vùng nỉ (mét); lights: vị trí đèn theo trục dài (mét, gốc ở giữa bàn).
 */
export function clothBakedTexture(w: number, h: number, lights: number[]): THREE.CanvasTexture {
  const cw = 1024, ch = Math.round((1024 * h) / w);
  const [c, g] = canvas(cw, ch);
  g.fillStyle = '#0c5a30'; g.fillRect(0, 0, cw, ch);
  for (const lx of lights) {
    const x = ((lx + w / 2) / w) * cw;
    const grd = g.createRadialGradient(x, ch / 2, 0, x, ch / 2, cw * 0.42);
    grd.addColorStop(0, 'rgba(46,170,96,0.95)');
    grd.addColorStop(0.55, 'rgba(32,140,78,0.55)');
    grd.addColorStop(1, 'rgba(20,110,60,0)');
    g.fillStyle = grd; g.fillRect(0, 0, cw, ch);
  }
  // tối dần sát băng
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const grd = g.createLinearGradient(x0, y0, x1, y1);
    grd.addColorStop(0, 'rgba(0,0,0,0.38)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    return grd;
  };
  const m = ch * 0.12;
  g.fillStyle = edge(0, 0, 0, m); g.fillRect(0, 0, cw, m);
  g.fillStyle = edge(0, ch, 0, ch - m); g.fillRect(0, ch - m, cw, m);
  g.fillStyle = edge(0, 0, m, 0); g.fillRect(0, 0, m, ch);
  g.fillStyle = edge(cw, 0, cw - m, 0); g.fillRect(cw - m, 0, m, ch);
  // sợi nỉ
  const img = g.getImageData(0, 0, cw, ch);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 9;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // UV của ShapeGeometry tính theo mét, gốc ở giữa -> đưa về [0, 1]
  t.repeat.set(1 / w, 1 / h);
  t.offset.set(0.5, 0.5);
  return t;
}
