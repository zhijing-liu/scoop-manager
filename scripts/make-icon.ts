/**
 * 生成应用图标（占位版）。
 *
 * 为什么自己画而不是用 `tauri icon`：
 *   `tauri icon` 需要一张至少 1024x1024 的源图，而仓库里只有界面截图。
 *   这里用纯 Node 把图标栅格化出来，零外部依赖、离线可用、结果确定。
 *
 * 产出：
 *   desktop/icons/icon.ico         多尺寸（16/32/48/64/128/256），BMP 编码
 *   desktop/icons/32x32.png
 *   desktop/icons/128x128.png
 *   desktop/icons/128x128@2x.png
 *
 * 图形沿用 public/index.html 里 favicon 的那个立方体轮廓（32x32 viewBox），
 * 便于后续替换成正式设计稿时保持视觉一致。
 *
 * 后续拿到正式图标时，直接覆盖 desktop/icons/ 下的文件即可，本脚本可以不再执行。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(import.meta.dir, '..');
const OUT_DIR = join(ROOT, 'desktop', 'icons');

// ---------------------------------------------------------------- 颜色与几何

/** 与前端主题一致的配色 */
const COLOR_BACKGROUND: Rgba = [11, 15, 22, 255]; // #0B0F16
const COLOR_BORDER: Rgba = [38, 51, 74, 255]; // #26334A
const COLOR_OUTLINE: Rgba = [76, 141, 255, 255]; // #4C8DFF
const COLOR_ACCENT: Rgba = [124, 92, 255, 255]; // #7C5CFF

type Rgba = [number, number, number, number];

/** 立方体顶点，坐标对应 32x32 的 viewBox */
const VERTICES = {
  top: [16, 6],
  rightTop: [25, 11],
  rightBottom: [25, 21],
  bottom: [16, 26],
  leftBottom: [7, 21],
  leftTop: [7, 11],
  center: [16, 16],
} as const;

const OUTLINE_EDGES: Array<[readonly number[], readonly number[]]> = [
  [VERTICES.top, VERTICES.rightTop],
  [VERTICES.rightTop, VERTICES.rightBottom],
  [VERTICES.rightBottom, VERTICES.bottom],
  [VERTICES.bottom, VERTICES.leftBottom],
  [VERTICES.leftBottom, VERTICES.leftTop],
  [VERTICES.leftTop, VERTICES.top],
];

const ACCENT_EDGES: Array<[readonly number[], readonly number[]]> = [
  [VERTICES.leftTop, VERTICES.center],
  [VERTICES.center, VERTICES.rightTop],
];

// ---------------------------------------------------------------- 有符号距离场

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 圆角矩形的有符号距离（负值在内部） */
function sdRoundRect(px: number, py: number, halfWidth: number, halfHeight: number, radius: number): number {
  const qx = Math.abs(px) - (halfWidth - radius);
  const qy = Math.abs(py) - (halfHeight - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - radius;
}

/** 点到线段的最短距离 */
function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : clamp01((wx * vx + wy * vy) / lengthSquared);
  return Math.hypot(wx - t * vx, wy - t * vy);
}

// ---------------------------------------------------------------- 合成

/** 预乘 alpha 的 source-over 叠加 */
function over(destination: number[], color: Rgba, coverage: number): number[] {
  const alpha = (color[3] / 255) * coverage;
  const inverse = 1 - alpha;
  return [
    (color[0] / 255) * alpha + destination[0] * inverse,
    (color[1] / 255) * alpha + destination[1] * inverse,
    (color[2] / 255) * alpha + destination[2] * inverse,
    alpha + destination[3] * inverse,
  ];
}

/** 把预乘结果转回直通 alpha 的 8 位 RGBA */
function toStraight(accumulated: number[]): [number, number, number, number] {
  const alpha = accumulated[3];
  if (alpha <= 0.0001) return [0, 0, 0, 0];
  const toByte = (value: number): number => Math.round(clamp01(value / alpha) * 255);
  return [toByte(accumulated[0]), toByte(accumulated[1]), toByte(accumulated[2]), Math.round(clamp01(alpha) * 255)];
}

/** 栅格化一张图标 */
function renderIcon(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const scale = size / 32; // 与 favicon 的 viewBox 对齐
  const inset = Math.max(0.75, 1.1 * scale);
  const radius = size * 0.22;
  const stroke = Math.max(1.3, 2.2 * scale);
  const halfStroke = stroke / 2;

  const toPixel = (point: readonly number[]): [number, number] => [point[0]! * scale, point[1]! * scale];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      let accumulated = [0, 0, 0, 0];

      // 1. 圆角方形底
      const backgroundDistance = sdRoundRect(px - size / 2, py - size / 2, size / 2 - inset, size / 2 - inset, radius);
      accumulated = over(accumulated, COLOR_BACKGROUND, clamp01(0.5 - backgroundDistance));

      // 2. 内描边（贴着底边内侧画一圈细线，让小尺寸下轮廓更清晰）
      const borderCoverage = clamp01(0.5 - Math.abs(backgroundDistance + 0.7 * scale));
      accumulated = over(accumulated, COLOR_BORDER, borderCoverage);

      // 3. 立方体轮廓
      let outlineCoverage = 0;
      for (const [start, end] of OUTLINE_EDGES) {
        const [ax, ay] = toPixel(start);
        const [bx, by] = toPixel(end);
        outlineCoverage = Math.max(outlineCoverage, clamp01(halfStroke + 0.5 - sdSegment(px, py, ax, ay, bx, by)));
      }
      accumulated = over(accumulated, COLOR_OUTLINE, outlineCoverage);

      // 4. 顶面两条棱（强调色）
      let accentCoverage = 0;
      for (const [start, end] of ACCENT_EDGES) {
        const [ax, ay] = toPixel(start);
        const [bx, by] = toPixel(end);
        accentCoverage = Math.max(accentCoverage, clamp01(halfStroke + 0.5 - sdSegment(px, py, ax, ay, bx, by)));
      }
      accumulated = over(accumulated, COLOR_ACCENT, accentCoverage);

      const [red, green, blue, alpha] = toStraight(accumulated);
      const offset = (y * size + x) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = alpha;
    }
  }

  return pixels;
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size: number, pixels: Uint8Array): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // 位深
  ihdr.writeUInt8(6, 9); // 颜色类型：RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // 每行前面加一个 filter 字节（0 = None）
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  const source = Buffer.from(pixels);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    source.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO 编码

/** 32 位 BMP 图标数据：BITMAPINFOHEADER + 自下而上的 BGRA + 全零 AND 掩码 */
function encodeBmpIcon(size: number, pixels: Uint8Array): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 高度含 AND 掩码
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB

  const stride = size * 4;
  const bitmap = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = (size - 1 - y) * stride; // BMP 是自下而上
    for (let x = 0; x < size; x += 1) {
      const from = sourceRow + x * 4;
      const to = y * stride + x * 4;
      bitmap[to] = pixels[from + 2]!;
      bitmap[to + 1] = pixels[from + 1]!;
      bitmap[to + 2] = pixels[from]!;
      bitmap[to + 3] = pixels[from + 3]!;
    }
  }

  // 1bpp AND 掩码，行按 4 字节对齐；32 位图标由 alpha 决定透明度，掩码置零即可
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);

  return Buffer.concat([header, bitmap, mask]);
}

function encodeIco(images: Array<{ size: number; pixels: Uint8Array }>): Buffer {
  const directory = Buffer.alloc(6);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // type = icon
  directory.writeUInt16LE(images.length, 4);

  const entries: Buffer[] = [];
  const payloads: Buffer[] = [];
  let offset = 6 + images.length * 16;

  for (const image of images) {
    const bitmap = encodeBmpIcon(image.size, image.pixels);

    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2); // 调色板数量
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // 位深
    entry.writeUInt32LE(bitmap.length, 8);
    entry.writeUInt32LE(offset, 12);

    entries.push(entry);
    payloads.push(bitmap);
    offset += bitmap.length;
  }

  return Buffer.concat([directory, ...entries, ...payloads]);
}

// ---------------------------------------------------------------- 入口

/**
 * 内容相同就不写盘。
 *
 * `tauri-build` 跟踪 `bundle.icon` 里的每个文件；若无条件覆盖，每次构建都会
 * 刷新 mtime，导致 build script 重跑进而整个 crate 重编译。图标是纯确定性
 * 产物，比对内容后跳过即可让 cargo 保持增量。
 */
function writeIfChanged(target: string, content: Buffer): boolean {
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (existing.length === content.length && existing.equals(content)) return false;
  }
  writeFileSync(target, content);
  return true;
}

const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const PNG_TARGETS: Array<{ file: string; size: number }> = [
  { file: '32x32.png', size: 32 },
  { file: '128x128.png', size: 128 },
  { file: '128x128@2x.png', size: 256 },
];

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  // 每个尺寸只渲染一次，ICO 与 PNG 复用
  const cache = new Map<number, Uint8Array>();
  const render = (size: number): Uint8Array => {
    const cached = cache.get(size);
    if (cached) return cached;
    const pixels = renderIcon(size);
    cache.set(size, pixels);
    return pixels;
  };

  console.log('生成应用图标（占位版）');

  const icoPath = join(OUT_DIR, 'icon.ico');
  const ico = encodeIco(ICO_SIZES.map((size) => ({ size, pixels: render(size) })));
  const icoWritten = writeIfChanged(icoPath, ico);
  console.log(
    `  icon.ico          ${(ico.length / 1024).toFixed(1)} KB  [${ICO_SIZES.join(', ')}]${icoWritten ? '' : '  内容未变，跳过写入'}`,
  );

  for (const target of PNG_TARGETS) {
    const png = encodePng(target.size, render(target.size));
    const written = writeIfChanged(join(OUT_DIR, target.file), png);
    console.log(
      `  ${target.file.padEnd(17)} ${(png.length / 1024).toFixed(1)} KB  [${target.size}]${written ? '' : '  内容未变，跳过写入'}`,
    );
  }

  console.log(`\n输出目录：${OUT_DIR}`);
  console.log('拿到正式图标后直接覆盖这些文件即可。');
}

main();
