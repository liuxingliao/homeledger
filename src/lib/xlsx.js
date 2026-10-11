'use strict';
/**
 * 最小 xlsx(OOXML)解析器 —— 仅用 Node 内置能力,零依赖
 * 覆盖随手记导出的结构:zip 容器 + sharedStrings + 工作表单元格
 * 支持共享字符串 / inlineStr / 数字 / 日期样式四种单元格
 */
const fs = require('fs');
const zlib = require('zlib');

/** 校验 zip 魔数并从 Buffer 中读取中央目录,返回 {name → {method, compressedSize, size, localHeaderOffset, compressed}} */
function readZipEntries(buf) {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('不是有效的 xlsx 文件（缺少 zip 魔数）');
  }
  // 从文件尾查找 End of Central Directory 签名 0x06054b50
  let eocd = -1;
  const minIdx = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minIdx; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（找不到 zip 中央目录）');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // zip64:偏移为 0xFFFFFFFF 时尝试定位 zip64 EOCD
  if (cdOffset === 0xffffffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x06 && buf[i + 3] === 0x07) {
        cdOffset = Number(buf.readBigUInt64LE(i + 8));
        break;
      }
    }
  }
  const entries = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cdOffset + 10);
    const compressedSize = buf.readUInt32LE(cdOffset + 20);
    const size = buf.readUInt32LE(cdOffset + 24);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    entries.set(name, { method, compressedSize, size, localHeaderOffset, compressed: method !== 0 });
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw new Error('xlsx 文件内没有任何条目');
  return entries;
}

/** 解压单个条目为 Buffer */
function extractEntry(buf, entry) {
  const lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('zip 本地文件头损坏');
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (!entry.compressed) return Buffer.from(raw);
  const out = zlib.inflateRawSync(raw);
  if (entry.size && out.length !== entry.size) throw new Error('zip 解压后长度不符');
  return out;
}

/** 读 xlsx 的 zip,返回 {path → Buffer} 只解压被请求的条目 */
function readXlsxEntries(buf, wanted) {
  const entries = readZipEntries(buf);
  const out = {};
  for (const [name, entry] of entries) {
    if (wanted.some((w) => name === w || name.endsWith('/' + w))) out[name] = extractEntry(buf, entry);
  }
  return out;
}

function xmlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}

/** 解析 sharedStrings.xml → 字符串数组 */
function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const ts = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) ts.push(xmlUnescape(t[1]));
    out.push(ts.join(''));
  }
  return out;
}

/** 从 styles.xml 收集日期样式的 xf 索引 */
function collectDateStyles(stylesXml) {
  const dateFmtIds = new Set(['14', '15', '16', '17', '18', '19', '20', '21', '22', '45', '46', '47']);
  const custom = new Set();
  for (const f of stylesXml.matchAll(/<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?/g)) {
    const code = f[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (/[ymdhs]/i.test(code) && !code.includes('[') && !/^0/.test(code)) custom.add(f[1]);
  }
  const ids = new Set();
  const xfBlock = stylesXml.match(/<cellXfs(?:\s[^>]*)?>([\s\S]*?)<\/cellXfs>/);
  if (xfBlock) {
    let idx = 0;
    for (const xf of xfBlock[1].matchAll(/<xf\s[^>]*?\/?>(?:[\s\S]*?<\/xf>)?/g)) {
      const nm = xf[0].match(/numFmtId="(\d+)"/);
      if (nm && (dateFmtIds.has(nm[1]) || custom.has(nm[1]))) ids.add(idx);
      idx++;
    }
  }
  return ids;
}

/** Excel 日期序列号 → 'YYYY-MM-DD HH:mm:ss'（本地时区） */
function excelSerialToDatetime(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function colLettersToIndex(letters) {
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

/**
 * 解析一个 worksheet XML → 二维字符串数组（日期序列号已转为 datetime 字符串）
 * 空单元格以 '' 表示
 */
function parseSheetXml(xml, sharedStrings, dateStyles) {
  const rows = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>|<row(?:\s[^>]*)?\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const inner = rm[1] || '';
    const cells = [];
    const cRe = /<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cRe.exec(inner))) {
      const attrs = cm[1] || cm[2] || '';
      const cellInner = cm[3] || '';
      const refM = attrs.match(/r="([A-Z]+)\d+"/);
      const col = refM ? colLettersToIndex(refM[1]) : cells.length;
      const tM = attrs.match(/t="([^"]+)"/);
      const sM = attrs.match(/s="(\d+)"/);
      let value = '';
      if (tM && tM[1] === 's') {
        const v = cellInner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        value = v ? sharedStrings[+v[1]] ?? '' : '';
      } else if (tM && tM[1] === 'inlineStr') {
        const ts = [];
        for (const t of cellInner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) ts.push(xmlUnescape(t[1]));
        value = ts.join('');
      } else if (tM && tM[1] === 'str') {
        const v = cellInner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        value = v ? xmlUnescape(v[1]) : '';
      } else {
        const v = cellInner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        if (v) {
          value = xmlUnescape(v[1]);
          if (sM && dateStyles.has(+sM[1])) {
            const num = parseFloat(value);
            if (!isNaN(num)) value = excelSerialToDatetime(num);
          }
        }
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * 主入口:解析 xlsx Buffer → { sheets: { 名称: string[][] }, sheetNames: [] }
 * throws Error 当文件损坏或结构不符
 */
function parseXlsx(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = readZipEntries(buf);
  const workbookName = [...entries.keys()].find((n) => /^xl\/workbook\.xml$/.test(n) || /workbook\.xml$/.test(n));
  if (!workbookName) throw new Error('xlsx 缺少 workbook.xml,不是有效的 Excel 文件');
  const data = { [workbookName]: extractEntry(buf, entries.get(workbookName)) };
  const wbXml = data[workbookName].toString('utf8');
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\s[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"[^>]*\/?>/g)) {
    sheets.push({ name: xmlUnescape(m[1]), rid: m[2] });
  }
  const relsName = [...entries.keys()].find((n) => /workbook\.xml\.rels$/.test(n));
  if (!relsName) throw new Error('xlsx 缺少 workbook 关系文件');
  data[relsName] = extractEntry(buf, entries.get(relsName));
  const rels = {};
  for (const r of data[relsName].toString('utf8').matchAll(/<Relationship\s[^>]*Id="(rId\d+)"[^>]*Target="([^"]+)"[^>]*\/?/g)) {
    rels[r[1]] = r[2];
  }
  const ssName = [...entries.keys()].find((n) => /sharedStrings\.xml$/.test(n));
  let sharedStrings = [];
  if (ssName) {
    data[ssName] = extractEntry(buf, entries.get(ssName));
    sharedStrings = parseSharedStrings(data[ssName].toString('utf8'));
  }
  const stylesName = [...entries.keys()].find((n) => /styles\.xml$/.test(n));
  let dateStyles = new Set();
  if (stylesName) {
    data[stylesName] = extractEntry(buf, entries.get(stylesName));
    dateStyles = collectDateStyles(data[stylesName].toString('utf8'));
  }
  const out = { sheetNames: [], sheets: {} };
  for (const s of sheets) {
    const target = rels[s.rid];
    if (!target) continue;
    const norm = target.replace(/^\//, '').replace(/^xl\//, '');
    const entryName = [...entries.keys()].find((n) => n === `xl/${norm}` || n.endsWith('/' + norm) || n === norm);
    if (!entryName) continue;
    const xml = extractEntry(buf, entries.get(entryName)).toString('utf8');
    out.sheetNames.push(s.name);
    out.sheets[s.name] = parseSheetXml(xml, sharedStrings, dateStyles);
  }
  if (!out.sheetNames.length) throw new Error('xlsx 中没有可识别的工作表');
  return out;
}

/** 判断 Buffer 是否 xlsx(zip 容器) */
function looksLikeXlsx(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
}

module.exports = { parseXlsx, looksLikeXlsx, readZipEntries, excelSerialToDatetime };
