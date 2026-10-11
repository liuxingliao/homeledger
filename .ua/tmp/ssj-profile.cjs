#!/usr/bin/env node
'use strict';
// 全面剖析随手记 xlsx:每张表每列的取值分布与边界情况,用于需求核对
const fs = require('fs');
const path = require('path');
const DIR = 'C:/Users/Administrator/Desktop/git/homeledger/.ua/tmp/ssj';

const ssjXml = fs.readFileSync(path.join(DIR, 'xl/sharedStrings.xml'), 'utf8');
const sharedStrings = [];
{ const re = /<si>([\s\S]*?)<\/si>/g; let m;
  while ((m = re.exec(ssjXml))) {
    const ts = []; const t2 = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let t;
    while ((t = t2.exec(m[1]))) ts.push(t[1]);
    sharedStrings.push(ts.join(''));
  } }
const unesc = (s) => s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');

const stylesXml = fs.readFileSync(path.join(DIR, 'xl/styles.xml'), 'utf8');
const customDateFmt = new Set();
for (const f of stylesXml.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) {
  if (/[yYmdHhs]/.test(f[2]) && !/\[/.test(f[2])) customDateFmt.add(f[1]);
}
const dateStyleIds = new Set();
{ const xfBlock = stylesXml.match(/<(?:cellXfs|cellStyleXfs)>([\s\S]*?)<\/(?:cellXfs|cellStyleXfs)>/);
  if (xfBlock) {
    [...xfBlock[1].matchAll(/<xf\s[^>]*numFmtId="(\d+)"/g)].forEach((x) => {
      if (['14','15','16','17','22'].includes(x[1]) || customDateFmt.has(x[1])) dateStyleIds.add(x[1]);
    });
  } }

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
      const attrs = cm[1] || cm[2] || ''; const inner = cm[3] || '';
      const refM = attrs.match(/r="([A-Z]+)(\d+)"/);
      let col = 0; if (refM) for (const ch of refM[1]) col = col * 26 + (ch.charCodeAt(0) - 64); col -= 1;
      const tM = attrs.match(/t="([^"]+)"/); const sM = attrs.match(/s="(\d+)"/);
      let value = null, type = 'n';
      if (tM && tM[1] === 's') { const v = inner.match(/<v>([\s\S]*?)<\/v>/); value = v ? unesc(sharedStrings[+v[1]]) : null; type = 's'; }
      else { const v = inner.match(/<v>([\s\S]*?)<\/v>/); if (v) { value = unesc(v[1]); if (sM && dateStyleIds.has(+sM[1])) type = 'd'; } }
      while (cells.length < col) cells.push(null);
      cells[col] = value === null ? null : { value, type };
    }
    rows.push(cells);
  }
  return rows;
}

function cellStr(c) {
  if (!c) return '';
  let v = String(c.value);
  if (c.type === 'd') { const serial = parseFloat(v); const d = new Date(Math.round((serial - 25569) * 86400000)); v = d.toISOString().slice(0, 19).replace('T', ' '); }
  return v.trim();
}

const wbXml = fs.readFileSync(path.join(DIR, 'xl/workbook.xml'), 'utf8');
const sheets = [...wbXml.matchAll(/<sheet name="([^"]+)"[^>]*r:id="rId(\d+)"/g)];
const relsXml = fs.readFileSync(path.join(DIR, 'xl/_rels/workbook.xml.rels'), 'utf8');
const rels = {};
for (const r of relsXml.matchAll(/Id="rId(\d+)"[^>]*Target="([^"]+)"/g)) rels['rId' + r[1]] = r[2];

const profile = {};
for (const s of sheets) {
  const file = rels['rId' + s[2]].replace(/^.*?worksheets\//, '');
  const rows = parseSheet(file);
  const header = rows[0].map(cellStr);
  const body = rows.slice(1).map((r) => r.map(cellStr)).filter((r) => r.join('').length > 0);
  const prof = { file, total: body.length, columns: {} };
  header.forEach((h, i) => {
    const vals = body.map((r) => r[i] ?? '');
    const nonEmpty = vals.filter((v) => v !== '' && v !== '·');
    const dist = {};
    for (const v of nonEmpty) dist[v] = (dist[v] || 0) + 1;
    prof.columns[h] = {
      empty: vals.length - nonEmpty.length,
      distinct: Object.keys(dist).length,
      dist: Object.keys(dist).length <= 30 ? dist : null,
      top: Object.entries(dist).sort((a,b)=>b[1]-a[1]).slice(0, 12),
      samples: nonEmpty.length ? [nonEmpty[0], nonEmpty[nonEmpty.length-1]] : [],
    };
  });
  // 特殊检查:金额非常规格式/零/负数
  const amtIdx = header.indexOf('金额');
  const amts = body.map((r) => r[amtIdx] ?? '').filter((v) => v !== '');
  prof.amountStats = {
    zero: amts.filter((v) => parseFloat(v) === 0).length,
    negative: amts.filter((v) => parseFloat(v) < 0).length,
    withComma: amts.filter((v) => v.includes(',')).length,
    nonNumeric: amts.filter((v) => isNaN(parseFloat(v))).length,
    maxAbs: Math.max(...amts.map((v) => Math.abs(parseFloat(v) || 0))),
    decimalsOver2: amts.filter((v) => /\.\d{3,}$/.test(v)).length,
  };
  // 日期范围
  const dIdx = header.indexOf('日期');
  const dates = body.map((r) => r[dIdx]).filter(Boolean).sort();
  prof.dateRange = [dates[0], dates[dates.length - 1]];
  profile[s[1]] = prof;
}

for (const [name, p] of Object.entries(profile)) {
  console.log('\n########## SHEET: ' + name + ' (' + p.file + ') rows=' + p.total + ' ##########');
  console.log('日期范围:', p.dateRange.join(' ~ '));
  console.log('金额统计:', JSON.stringify(p.amountStats));
  for (const [h, c] of Object.entries(p.columns)) {
    console.log('  [' + h + '] 空=' + c.empty + ' 去重=' + c.distinct + (c.dist !== null ? ' 分布=' + JSON.stringify(c.dist) : ' top=' + JSON.stringify(c.top)));
  }
}
