#!/usr/bin/env node
'use strict';
// 解析随手记 xlsx(已解压的 XML),输出每个 sheet 的表头与前几行数据
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2];
const ssjXml = fs.readFileSync(path.join(DIR, 'xl/sharedStrings.xml'), 'utf8');
// shared strings: <si>...<t>text</t>...</si>
const sharedStrings = [];
const siRe = /<si>([\s\S]*?)<\/si>/g;
let m;
while ((m = siRe.exec(ssjXml))) {
  const ts = [];
  const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let t;
  while ((t = tRe.exec(m[1]))) ts.push(t[1]);
  sharedStrings.push(ts.join(''));
}
function unesc(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
// styles: count how many date-like formats exist
const stylesXml = fs.readFileSync(path.join(DIR, 'xl/styles.xml'), 'utf8');
const numFmtIds = [...stylesXml.matchAll(/<numFmtId="(\d+)"/g)].map(x => x[1]);
const builtinDateFmt = new Set(['14', '15', '16', '17', '22', '164', '165', '176', '177']);
const customFmtMatches = [...stylesXml.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)];
const customDateFmt = new Set();
for (const f of customFmtMatches) {
  if (/[yYmdHhs]/.test(f[2]) && !/\[/.test(f[2])) customDateFmt.add(f[1]);
}
const dateStyleIds = new Set();
const xfRe = /<(?:cellXfs|cellStyleXfs)>([\s\S]*?)<\/(?:cellXfs|cellStyleXfs)>/;
const xfBlock = stylesXml.match(xfRe);
if (xfBlock) {
  const xfs = [...xfBlock[1].matchAll(/<xf\s[^>]*numFmtId="(\d+)"/g)];
  xfs.forEach((x, i) => { if (builtinDateFmt.has(x[1]) || customDateFmt.has(x[1])) dateStyleIds.add(i); });
}

function parseSheet(file) {
  const xml = fs.readFileSync(path.join(DIR, 'xl/worksheets', file), 'utf8');
  const rows = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cRe.exec(rm[2]))) {
      const attrs = cm[1] || cm[2] || '';
      const inner = cm[3] || '';
      const refM = attrs.match(/r="([A-Z]+)(\d+)"/);
      const colLetters = refM ? refM[1] : '';
      let col = 0;
      for (const ch of colLetters) col = col * 26 + (ch.charCodeAt(0) - 64);
      col -= 1;
      const tM = attrs.match(/t="([^"]+)"/);
      const sM = attrs.match(/s="(\d+)"/);
      const styleIdx = sM ? parseInt(sM[1], 10) : -1;
      let value = null;
      let type = 'n';
      if (tM && tM[1] === 's') {
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vM ? unesc(sharedStrings[parseInt(vM[1], 10)]) : null;
        type = 's';
      } else if (tM && tM[1] === 'inlineStr') {
        const tM2 = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
        value = tM2 ? unesc(tM2[1]) : null;
        type = 's';
      } else if (tM && tM[1] === 'str') {
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vM ? unesc(vM[1]) : null;
        type = 'str';
      } else {
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (vM) {
          value = unesc(vM[1]);
          if (dateStyleIds.has(styleIdx)) type = 'd';
        }
      }
      while (cells.length < col) cells.push(null);
      cells[col] = value === null ? null : { value, type };
    }
    rows.push(cells);
  }
  return rows;
}

const wbXml = fs.readFileSync(path.join(DIR, 'xl/workbook.xml'), 'utf8');
const sheets = [...wbXml.matchAll(/<sheet name="([^"]+)"[^>]*r:id="rId(\d+)"/g)];
const relsXml = fs.readFileSync(path.join(DIR, 'xl/_rels/workbook.xml.rels'), 'utf8');
const rels = {};
for (const r of relsXml.matchAll(/Id="rId(\d+)"[^>]*Target="([^"]+)"/g)) rels['rId' + r[1]] = r[2];

const MAX_ROWS = parseInt(process.argv[3] || '6', 10);
for (const s of sheets) {
  const target = rels['rId' + s[2]];
  const file = target.replace(/^.*?worksheets\//, '').replace(/^xl\//, '').replace(/^\/xl\//, '');
  console.log('===== SHEET: ' + s[1] + ' (' + file + ') =====');
  const rows = parseSheet(file);
  console.log('total rows:', rows.length);
  rows.slice(0, MAX_ROWS).forEach((r, i) => {
    const cells = r.map(c => {
      if (c === null || c === undefined) return '·';
      let v = String(c.value);
      if (c.type === 'd') {
        // Excel serial date
        const serial = parseFloat(v);
        const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
        v = v + ' → ' + d.toISOString().slice(0, 19).replace('T', ' ');
      }
      return v.length > 40 ? v.slice(0, 40) + '…' : v;
    });
    console.log('row' + (i + 1) + ':', JSON.stringify(cells));
  });
}
