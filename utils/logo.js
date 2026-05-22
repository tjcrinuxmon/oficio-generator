/**
 * Genera el logo INE como PNG puro sin dependencias externas.
 * Devuelve un Buffer PNG listo para incrustar en ExcelJS.
 */
const zlib = require('zlib');

// ── CRC32 (requerido por el formato PNG) ─────────────────────────────────────
const CRC32 = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return (buf) => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
})();

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(d.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crc]);
}

function buildPNG(w, h, getPixel) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3); // filter byte (0=None) + RGB
    for (let x = 0; x < w; x++) {
      const [r, g, b] = getPixel(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Paleta INE ───────────────────────────────────────────────────────────────
const PURPLE  = [88,  46,  115]; // #582E73
const MAGENTA = [228,  0,  123]; // #E4007B
const WHITE   = [255, 255, 255];

// ── Bitmaps de caracteres 5×7 (escala 3x) ───────────────────────────────────
const GLYPHS = {
  I: [
    [1,1,1,1,1],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [1,1,1,1,1],
  ],
  N: [
    [1,0,0,0,1],
    [1,1,0,0,1],
    [1,0,1,0,1],
    [1,0,0,1,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
  ],
  E: [
    [1,1,1,1,1],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,1,1,1,0],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,1,1,1,1],
  ],
};

function glyphPixel(char, gx, gy, scale = 3) {
  const g = GLYPHS[char];
  if (!g) return false;
  const row = Math.floor(gy / scale);
  const col = Math.floor(gx / scale);
  return row < g.length && col < g[0].length && g[row][col] === 1;
}

// ── Generador principal ──────────────────────────────────────────────────────
let _cached = null;

function generateINELogoBuffer() {
  if (_cached) return _cached;

  const W = 120, H = 64;
  const SCALE = 3;
  const GLYPH_W = 5 * SCALE;  // 15px per char
  const GLYPH_H = 7 * SCALE;  // 21px per char
  const GLYPH_GAP = 3;         // px between chars

  // Diamond geometry
  const dCx = W / 2, dCy = H / 2, dR = 22;

  // "INE" text layout (centered below diamond or to the side)
  // We place "INE" centered horizontally, at y = H - GLYPH_H - 4
  const text = ['I', 'N', 'E'];
  const textTotalW = text.length * GLYPH_W + (text.length - 1) * GLYPH_GAP;
  const textX0 = Math.floor((W - textTotalW) / 2);
  const textY0 = H - GLYPH_H - 5;

  _cached = buildPNG(W, H, (x, y) => {
    // Diamond (rhombus using Manhattan distance)
    const dx = Math.abs(x - dCx);
    const dy = Math.abs(y - dCy);
    if (dx + dy < dR - 1) return MAGENTA;  // inner magenta
    if (dx + dy < dR + 1) return WHITE;    // thin white border

    // "INE" pixel-art text
    const ry = y - textY0;
    const rx = x - textX0;
    if (ry >= 0 && ry < GLYPH_H && rx >= 0 && rx < textTotalW) {
      for (let i = 0; i < text.length; i++) {
        const charX = rx - i * (GLYPH_W + GLYPH_GAP);
        if (charX >= 0 && charX < GLYPH_W) {
          if (glyphPixel(text[i], charX, ry, SCALE)) return WHITE;
        }
      }
    }

    return PURPLE;
  });

  return _cached;
}

module.exports = { generateINELogoBuffer };
