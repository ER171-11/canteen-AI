'use strict';
/*
 * zipread.js — 纯 Node 内置 ZIP 读取（零第三方依赖）
 *
 * 背景：node:sqlite / node:zlib 均内置，但 Node 没有内置 ZIP API。
 * docx/xlsx 都是 ZIP 容器，本模块用 node:zlib.inflateRawSync 解 deflate 条目，
 * 仅实现「只读」所需的最小 ZIP 解析：
 *   End of Central Directory (EOCD, 0x06054b50)
 *     → 中央目录项 (0x02014b50)
 *       → 本地文件头 (0x04034b50) → 压缩数据
 *
 * 支持压缩方法：0=stored（原样）、8=deflate（inflateRawSync）。
 * 对齐 Python zipfile 的常用行为：按条目名精确读取、namelist。
 *
 * 用法：
 *   const { openZip, readEntry, listEntries } = require('./zipread');
 *   const buf = readEntry('a.docx', 'word/document.xml');
 *   const names = listEntries('a.xlsx').map(e => e.name);
 */

const fs = require('fs');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// 压缩方法
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// EOCD 固定 22 字节 + 最多 65535 字节注释
const EOCD_MIN = 22;
const EOCD_MAX_SCAN = EOCD_MIN + 0xffff;

/** 从尾部向前定位 EOCD，返回其在 buf 中的偏移；找不到返回 -1。 */
function findEocd(buf) {
  const start = Math.max(0, buf.length - EOCD_MAX_SCAN);
  for (let i = buf.length - EOCD_MIN; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** 解析中央目录，返回 Map<name, entry>；entry 带本地头偏移与大小。 */
function parseCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到 EOCD');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let pos = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || pos === 0xffffffff) {
    throw new Error('暂不支持 ZIP64');
  }
  const entries = new Map();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error('中央目录损坏：偏移 ' + pos + ' 签名不符');
    }
    const method = buf.readUInt16LE(pos + 10);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.set(name, {
      name,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      offset: localOffset,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压单个条目数据。 */
function extract(buf, entry) {
  const off = entry.offset;
  if (buf.readUInt32LE(off) !== SIG_LOCAL) {
    throw new Error('本地文件头损坏：' + entry.name);
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const end = dataStart + entry.compressedSize;
  const raw = buf.slice(dataStart, end);
  if (entry.method === METHOD_STORED) return Buffer.from(raw);
  if (entry.method === METHOD_DEFLATE) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方法 ' + entry.method + '：' + entry.name);
}

class ZipFile {
  constructor(buf) {
    this.buf = buf;
    this.entries = parseCentralDirectory(buf);
  }

  has(name) {
    return this.entries.has(name);
  }

  /** 对齐 Python zipfile.namelist() */
  namelist() {
    return Array.from(this.entries.keys());
  }

  /** 返回条目元信息数组 [{name, method, compressedSize, uncompressedSize, crc32, offset}] */
  list() {
    return Array.from(this.entries.values()).map((e) => ({
      name: e.name,
      method: e.method,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      crc32: e.crc32,
      offset: e.offset,
    }));
  }

  /** 读取条目为 Buffer；不存在抛错（对齐 Python KeyError） */
  read(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error('ZIP 中不存在条目: ' + name);
    return extract(this.buf, e);
  }
}

/** 打开本地 ZIP 文件 */
function openZip(zipPath) {
  return new ZipFile(fs.readFileSync(zipPath));
}

/** 读取指定条目（每次重新打开；批量读取建议用 openZip 复用） */
function readEntry(zipPath, name) {
  return openZip(zipPath).read(name);
}

/** 列出 ZIP 内全部条目 */
function listEntries(zipPath) {
  return openZip(zipPath).list();
}

module.exports = { ZipFile, openZip, readEntry, listEntries };
