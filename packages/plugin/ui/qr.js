// 零依赖 QR 编码器（byte 模式，纠错等级 L，版本 1–6）。
// 只被本机管理页使用；远端入口不加载它。产物为布尔矩阵，交给 canvas 绘制。

const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172];
const ECC_CODEWORDS = [7, 10, 15, 20, 26, 18];
const BLOCKS = [1, 1, 1, 1, 1, 2];
const ALIGN_CENTER = [0, 18, 22, 26, 30, 34];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

export function rsEncode(data, eccCount) {
  const gen = rsGenerator(eccCount);
  const result = new Array(eccCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < eccCount; i += 1) result[i] ^= gfMul(gen[i + 1], factor);
  }
  return result;
}

/** 校验码字满足 RS 校验子全零（用于自测） */
export function rsSyndromes(codewords, eccCount) {
  const out = [];
  for (let i = 0; i < eccCount; i += 1) {
    let sum = 0;
    for (const byte of codewords) sum = gfMul(sum, GF_EXP[i]) ^ byte;
    out.push(sum);
  }
  return out;
}

function pickVersion(byteLength) {
  for (let v = 1; v <= 6; v += 1) {
    const capacityBits = (TOTAL_CODEWORDS[v - 1] - ECC_CODEWORDS[v - 1] * BLOCKS[v - 1]) * 8;
    if (4 + 8 + byteLength * 8 <= capacityBits) return v;
  }
  throw new Error(`内容过长，超出 v6-L 容量（${byteLength} 字节）`);
}

function buildBitStream(bytes, version) {
  const dataCodewords = TOTAL_CODEWORDS[version - 1] - ECC_CODEWORDS[version - 1] * BLOCKS[version - 1];
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const capacityBits = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const pads = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < dataCodewords) codewords.push(pads[padIndex++ % 2]);
  return codewords;
}

function interleave(codewords, version, eccCount, blockCount) {
  if (blockCount === 1) return [...codewords, ...rsEncode(codewords, eccCount)];
  const per = codewords.length / blockCount;
  const dataBlocks = [];
  const eccBlocks = [];
  for (let i = 0; i < blockCount; i += 1) {
    const block = codewords.slice(i * per, (i + 1) * per);
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, eccCount));
  }
  const out = [];
  for (let i = 0; i < per; i += 1) for (const block of dataBlocks) out.push(block[i]);
  for (let i = 0; i < eccCount; i += 1) for (const block of eccBlocks) out.push(block[i]);
  return out;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function formatBits(mask) {
  const data = (0b01 << 3) | mask; // 纠错等级 L = 0b01
  let value = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >> i) & 1) value ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function makeMatrix(version) {
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => {
    if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v;
  };

  const finder = (top, left) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const inside = r >= 0 && r < 7 && c >= 0 && c < 7;
        const ring = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(top + r, left + c, inside ? ring : false);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  if (version > 1) {
    const center = ALIGN_CENTER[version - 1];
    const positions = [6, center];
    for (const r of positions) {
      for (const c of positions) {
        if (m[r][c] !== null) continue;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const ring = Math.max(Math.abs(dr), Math.abs(dc));
            set(r + dr, c + dc, ring !== 1);
          }
        }
      }
    }
  }

  // 预留格式信息区域
  for (let i = 0; i < 9; i += 1) {
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i += 1) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  m[size - 8][8] = true; // 固定暗模块

  return m;
}

function placeData(m, codewords) {
  const size = m.length;
  const bits = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) / 2) % 2 === 1;
        const row = upward ? size - 1 - vert : vert;
        if (m[row][col] !== null) continue;
        m[row][col] = index < bits.length ? bits[index] === 1 : false;
        index += 1;
      }
    }
  }
}

function applyFormat(m, mask) {
  const size = m.length;
  const bits = formatBits(mask);
  const bit = (i) => ((bits >> (14 - i)) & 1) === 1;
  for (let i = 0; i < 6; i += 1) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i < 15; i += 1) m[14 - i][8] = bit(i);
  for (let i = 0; i < 8; i += 1) m[size - 1 - i][8] = bit(i);
  for (let i = 8; i < 15; i += 1) m[8][size - 15 + i] = bit(i);
}

function applyMask(m, mask) {
  const size = m.length;
  const fn = MASKS[mask];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (isFunctionModule(m, r, c)) continue;
      if (fn(r, c)) m[r][c] = !m[r][c];
    }
  }
}

function isFunctionModule(m, r, c) {
  const size = m.length;
  const inFinder = (r < 9 && c < 9) || (r < 9 && c >= size - 8) || (r >= size - 8 && c < 9);
  if (inFinder) return true;
  if (r === 6 || c === 6) return true;
  if (m[r][c] === null) return false;
  return false;
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  const runScore = (line) => {
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  };
  for (let r = 0; r < size; r += 1) runScore(m[r]);
  for (let c = 0; c < size; c += 1) runScore(m.map((row) => row[c]));

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  const pattern = [true, false, true, true, true, false, true];
  const matches = (line, start) => pattern.every((p, i) => line[start + i] === p);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + 7 <= size; c += 1) if (matches(m[r], c)) score += 40;
  }
  for (let c = 0; c < size; c += 1) {
    const column = m.map((row) => row[c]);
    for (let r = 0; r + 7 <= size; r += 1) if (matches(column, r)) score += 40;
  }

  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/** 生成 QR 布尔矩阵：true 表示深色模块 */
export function encodeQr(text) {
  return encodeQrWithMask(text, null);
}

/** 指定掩码生成（测试与调试用；null 表示按罚分自动选择） */
export function encodeQrWithMask(text, forcedMask) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const dataCodewords = buildBitStream(bytes, version);
  const codewords = interleave(dataCodewords, version, ECC_CODEWORDS[version - 1], BLOCKS[version - 1]);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    if (forcedMask !== null && mask !== forcedMask) continue;
    const m = makeMatrix(version);
    placeData(m, codewords);
    applyMask(m, mask);
    applyFormat(m, mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/** 在 canvas 上绘制；调用方负责传入已挂载的 canvas 元素 */
export function drawQr(canvas, matrix, scale = 4, margin = 8) {
  const size = matrix.length;
  const total = (size + margin * 2) * scale;
  canvas.width = total;
  canvas.height = total;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = "#000";
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (matrix[r][c]) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
  }
}

if (typeof window !== "undefined") {
  window.DSHAnywhereQr = { encodeQr, drawQr };
}
