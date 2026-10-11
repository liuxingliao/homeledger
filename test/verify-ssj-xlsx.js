'use strict';
/**
 * 回归:随手记 xlsx 解析(xlsx.js + importers-suishouji.js)
 * 针对真实随手记导出样例 test/fixtures/suishouji-sample.xlsx 断言:
 *   7 张表完整读取、表头/行列数、日期时间精度、金额格式
 * 运行:node test/verify-ssj-xlsx.js
 */
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
const footer = () => console.log(`\n${pass} 通过 / ${fail} 失败`);

const fixture = path.join(__dirname, 'fixtures', 'suishouji-sample.xlsx');
if (!fs.existsSync(fixture)) {
  console.log('  FAIL  缺少样例文件 test/fixtures/suishouji-sample.xlsx');
  footer();
  process.exit(1);
}

const { parseXlsx, looksLikeXlsx } = require('../src/lib/xlsx');
const { parseWorkbook, normalizeSsjRecords, detectSuishouji } = require('../src/lib/importers-suishouji');

const buf = fs.readFileSync(fixture);
const wb = parseXlsx(buf);

console.log('\n=== A. xlsx 基础解析 ===\n');
check('zip 魔数识别', looksLikeXlsx(buf) === true);
check('识别出 7 张工作表', wb.sheetNames.length === 7, wb.sheetNames.join(','));
for (const [name, expect] of [['支出', 417], ['收入', 476], ['负债变更', 13], ['代付', 3], ['借入', 2], ['转账', 4], ['收债', 2]]) {
  check(`表「${name}」行数 = ${expect}(含表头)`, wb.sheets[name].length === expect, String(wb.sheets[name].length));
}
const hdr = wb.sheets['支出'][0];
check('支出表头 13 列', hdr.length === 13 && hdr[0] === '交易类型' && hdr[6] === '金额' && hdr[12] === '备注', JSON.stringify(hdr));
check('日期时间精度到秒', wb.sheets['支出'][1][1] === '2026-08-31 22:33:41', wb.sheets['支出'][1][1]);
check('金额字符串保留原始精度', wb.sheets['支出'][1][6] === '480.0', wb.sheets['支出'][1][6]);

console.log('\n=== B. 随手记规范化 ===\n');
const parsed = parseWorkbook(wb);
check('detectSuishouji 命中(≥3 张表名匹配)', detectSuishouji({ sheetNames: parsed.present }) === true);
const norm = normalizeSsjRecords(parsed);
check('910 条记录零丢失', norm.records.length === 910, String(norm.records.length));
check('0 条解析失败', norm.failedRows.length === 0, JSON.stringify(norm.failedRows.slice(0, 3)));
const byType = {};
for (const r of norm.records) byType[r.type] = (byType[r.type] || 0) + 1;
check('类型分布 支出416/收入475', byType.expense === 416 && byType.income === 475, JSON.stringify(byType));
check('类型分布 adjust12/lend2/borrow1/transfer3/repay_receive1',
  byType.adjust === 12 && byType.lend === 2 && byType.borrow === 1 && byType.transfer === 3 && byType.repay_receive === 1);

// 负债变更符号:11 负 + 1 正(410000 元)
const adj = norm.records.filter((r) => r.type === 'adjust');
check('负债变更 12 条,11 负 1 正', adj.filter((a) => a.adjust.rawCents < 0).length === 11 && adj.filter((a) => a.adjust.rawCents > 0).length === 1);
check('正值 410000 元(债务入账)保留原始符号', adj.some((a) => a.adjust.rawCents === 41000000));

// 借贷类对手方提取
const lend = norm.records.find((r) => r.type === 'lend');
check('代付 → lend,merchant=刘妈,应收账户=刘妈欠款', lend.merchant === '刘妈' && lend.to_account_hint === '刘妈欠款' && lend.account_hint === '应急兜底资金');
const borrow = norm.records.find((r) => r.type === 'borrow');
check('借入 → borrow,主账户=家庭建设资金,merchant=润辛妈', borrow.account_hint === '家庭建设资金' && borrow.merchant === '润辛妈');
const repay = norm.records.find((r) => r.type === 'repay_receive');
check('收债 → repay_receive,merchant=刘志杰', repay.merchant === '刘志杰');

// 成员与空成员容错
const noPeople = norm.records.filter((r) => r.people.length === 0);
check('无成员记录 13 条(12 负债变更 + 1 收入),行不丢弃', noPeople.length === 13);
check('成员列解析(宝宝/刘星燎)', norm.records.some((r) => r.people.includes('宝宝') && r.people.includes('刘星燎')) === false && norm.records.filter((r) => r.people.length === 1).length === 910 - 13);

// 项目分类常量列与项目标签
check('项目分类列仅两种取值("所有"/空),不含额外信息', [...new Set(norm.records.map((r) => r.meta.projectCategory))].every((v) => v === '所有' || v === ''));
check('项目 → tags_hint(如「房贷」)', norm.records.some((r) => r.tags_hint.includes('房贷')) === true);

// 分类 trim 与收入一级跳过
check('二级分类已 trim', norm.records.every((r) => !r.category_hint || r.category_hint === r.category_hint.trim()));
check('收入记录 parent_category_hint 为 null(一级恒为"收入")', norm.records.filter((r) => r.type === 'income').every((r) => r.parent_category_hint === null));
check('支出记录保留一级分类', norm.records.filter((r) => r.type === 'expense').every((r) => r.parent_category_hint));

// 源时间指纹字段
check('每条记录带 source_time(精确到秒)', norm.records.every((r) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.source_time)));

footer();
process.exit(fail ? 1 : 0);
