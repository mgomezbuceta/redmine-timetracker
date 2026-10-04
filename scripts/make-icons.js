// Genera los iconos PNG de la bandeja (22x22) sin dependencias.
const zlib = require('zlib'), fs = require('fs');
function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, pixel) {
  const raw = [];
  for (let y = 0; y < size; y++) { raw.push(0); for (let x = 0; x < size; x++) raw.push(...pixel(x, y)); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
}
function clock(color) {
  const S = 22, c = 10.5;
  return png(S, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    const ring = d <= 10 && d >= 7.8;
    const handV = x >= 10 && x <= 11 && y >= 4 && y <= 11;
    const handH = y >= 10 && y <= 11 && x >= 10 && x <= 15;
    return ring || handV || handH ? [...color, 255] : [0, 0, 0, 0];
  });
}
fs.writeFileSync(__dirname + '/../assets/tray-off.png', clock([200, 200, 200]));
fs.writeFileSync(__dirname + '/../assets/tray-on.png', clock([60, 200, 100]));

// Icono de la aplicación para los instaladores (512x512): reloj blanco sobre
// cuadrado verde redondeado, con suavizado por supermuestreo 4x4.
function appIcon(S = 512) {
  const inside = (x, y) => {
    const r = S * 0.22, m = S * 0.04; // radio de esquina y margen
    const cx = Math.min(Math.max(x, m + r), S - m - r), cy = Math.min(Math.max(y, m + r), S - m - r);
    if (Math.hypot(x - cx, y - cy) > r) return null;
    const c = S / 2, d = Math.hypot(x - c, y - c), u = S / 22;
    const ring = d <= 6.8 * u && d >= 5.4 * u;
    const handV = Math.abs(x - c) <= 0.55 * u && y >= c - 4.2 * u && y <= c + 0.5 * u;
    const handH = Math.abs(y - c) <= 0.55 * u && x >= c - 0.5 * u && x <= c + 3.4 * u;
    return ring || handV || handH ? [255, 255, 255] : [47, 191, 134];
  };
  return png(S, (x, y) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const p = inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4);
      if (p) { r += p[0]; g += p[1]; b += p[2]; n++; }
    }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(255 * n / 16)] : [0, 0, 0, 0];
  });
}
fs.writeFileSync(__dirname + '/../assets/icon.png', appIcon());
