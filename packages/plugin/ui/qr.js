// 零依赖 QR 编码器：byte 模式、纠错等级 L、版本 1–6（最多 134 字节，够放配对链接）。
// 算法按 ISO/IEC 18004 实现：定位/对齐/时序图形、格式信息 BCH、8 种掩码按罚分择优。
// 只被本地管理界面使用；测试用 jsQR 把矩阵解码回文本做回读校验。

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

/** 校验码字满足 RS 校验子全零（自测用） */
export function rsSyndromes(codewords, eccCount) {
  const out = [];
  for (let i = 0; i < eccCount; i += 1) {
    let sum = 0;
    for (const byte of codewords) sum = gfMul(sum, GF_EXP[i]) ^ byte;
    out.push(sum);
  }
  return out;
}

// 版本表（纠错等级 L）：总码字数、每块校验码字数、块数、对齐图形中心
const SPECS = [
  { total: 26, ecc: 7, blocks: 1, align: [] },
  { total: 44, ecc: 10, blocks: 1, align: [6, 18] },
  { total: 70, ecc: 15, blocks: 1, align: [6, 22] },
  { total: 100, ecc: 20, blocks: 1, align: [6, 26] },
  { total: 134, ecc: 26, blocks: 1, align: [6, 30] },
  { total: 172, ecc: 18, blocks: 2, align: [6, 34] },
];

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

function dataCodewordCount(version) {
  const spec = SPECS[version - 1];
  return spec.total - spec.ecc * spec.blocks;
}

function pickVersion(byteLength) {
  for (let version = 1; version <= SPECS.length; version += 1) {
    if (4 + 8 + byteLength * 8 <= dataCodewordCount(version) * 8) return version;
  }
  throw new Error(`内容过长：byte 模式 + L 级最多支持 ${dataCodewordCount(SPECS.length) - 2} 字节`);
}

function buildDataCodewords(bytes, version) {
  const capacity = dataCodewordCount(version);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte 模式
  push(bytes.length, 8); // v1–v9 的字符计数是 8 位
  for (const byte of bytes) push(byte, 8);
  const capacityBits = capacity * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0); // 终止符
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const pads = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < capacity) codewords.push(pads[padIndex++ % 2]);
  return codewords;
}

function interleave(codewords, version) {
  const spec = SPECS[version - 1];
  if (spec.blocks === 1) return [...codewords, ...rsEncode(codewords, spec.ecc)];
  const per = codewords.length / spec.blocks;
  const dataBlocks = [];
  const eccBlocks = [];
  for (let i = 0; i < spec.blocks; i += 1) {
    const block = codewords.slice(i * per, (i + 1) * per);
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, spec.ecc));
  }
  const out = [];
  for (let i = 0; i < per; i += 1) for (const block of dataBlocks) out.push(block[i]);
  for (let i = 0; i < spec.ecc; i += 1) for (const block of eccBlocks) out.push(block[i]);
  return out;
}

function formatBits(mask) {
  const data = (0b01 << 3) | mask; // 纠错等级 L = 0b01
  let value = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >> i) & 1) value ^= 0x537 << (i - 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

function makeMatrix(version, mask) {
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  const probe = (row0, col0) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = row0 + r;
        const col = col0 + c;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const inSquare = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inSquare && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        m[row][col] = dark;
      }
    }
  };
  probe(0, 0);
  probe(size - 7, 0);
  probe(0, size - 7);

  for (const row0 of SPECS[version - 1].align) {
    for (const col0 of SPECS[version - 1].align) {
      if (row0 === 6 && col0 === 6) continue;
      if (m[row0][col0] !== null) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          m[row0 + r][col0 + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
  }

  const bits = formatBits(mask);
  const dark = (i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) m[i][8] = dark(i);
    else if (i < 8) m[i + 1][8] = dark(i);
    else m[size - 15 + i][8] = dark(i);
  }
  for (let i = 0; i < 15; i += 1) {
    if (i < 8) m[8][size - i - 1] = dark(i);
    else if (i < 9) m[8][15 - i] = dark(i);
    else m[8][14 - i] = dark(i);
  }
  m[size - 8][8] = true; // 固定暗模块

  return m;
}

function placeData(m, codewords, mask) {
  const size = m.length;
  const applyMask = MASKS[mask];
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const target = col - c;
        if (m[row][target] !== null) continue;
        let value = false;
        if (byteIndex < codewords.length) value = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
        if (applyMask(row, target)) value = !value;
        m[row][target] = value;
        bitIndex -= 1;
        if (bitIndex === -1) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
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

  let darkCount = 0;
  for (const row of m) for (const cell of row) if (cell) darkCount += 1;
  const ratio = (darkCount * 100) / (size * size);
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
  const codewords = interleave(buildDataCodewords(bytes, version), version);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    if (forcedMask !== null && mask !== forcedMask) continue;
    const m = makeMatrix(version, mask);
    placeData(m, codewords, mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/** 把矩阵栅格化成 RGBA 像素（无 canvas 环境自测、或需要直接取像素时用） */
export function rasterizeQr(matrix, scale = 4, margin = 4) {
  const size = matrix.length;
  const width = (size + margin * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const row = Math.floor(y / scale) - margin;
      const col = Math.floor(x / scale) - margin;
      const dark = row >= 0 && row < size && col >= 0 && col < size && matrix[row][col];
      const i = (y * width + x) * 4;
      const value = dark ? 0 : 255;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width };
}

/**
 * 在 canvas 上绘制。尺寸按整数模块像素计算（默认目标约 196px），
 * 再按设备像素比放大画布，避免浏览器缩放把模块边缘糊掉。
 */
export function drawQr(canvas, matrix, options) {
  const margin = options && typeof options.margin === "number" ? options.margin : 4;
  const target = options && typeof options.target === "number" ? options.target : 196;
  const size = matrix.length;
  const total = size + margin * 2;
  const scale = Math.max(2, Math.floor(target / total));
  const cssSize = total * scale;
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? Math.min(window.devicePixelRatio, 3) : 1;

  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  canvas.style.imageRendering = "pixelated";

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cssSize, cssSize);
  ctx.fillStyle = "#000";
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (matrix[r][c]) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
  }
  return { size: cssSize, scale };
}

if (typeof window !== "undefined") {
  window.DSHAnywhereQr = { encodeQr, drawQr, rasterizeQr };
}
