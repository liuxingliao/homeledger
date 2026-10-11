'use strict';
/**
 * 随手记 xlsx 账本导入
 * 源格式:7 张工作表(支出/收入/负债变更/代付/借入/转账/收债)
 * 通用列:交易类型, 日期(含时间), 一级分类, 二级分类, 账户列, 账户币种, 金额, 成员, 商家, 项目分类, 项目, 记账人, 备注
 * 语义决策见 openspec/changes/import-suishouji-ledger/design.md D3/D4/D11
 */
const { parseAmountToCents } = require('./util');

/** 工作表名 → 交易类型 */
const SHEET_TYPE = {
  支出: 'expense',
  收入: 'income',
  转账: 'transfer',
  代付: 'lend',
  借入: 'borrow',
  收债: 'repay_receive',
  负债变更: 'adjust',
};

/** 各表账户列布局:{ main: 付款/收款主体, to: 对方账户 } */
const SHEET_ACCOUNTS = {
  支出: { main: '支出账户', to: null },
  收入: { main: '收入账户', to: null },
  转账: { main: '转出账户', to: '转入账户' },
  // 代付:账户1=付款方(钱从这里出),账户2=被代付人欠款户(应收)
  代付: { main: '账户1', to: '账户2' },
  // 借入:账户2=收款方(钱进这里),账户1=出借人欠款户(应付)
  借入: { main: '账户2', to: '账户1' },
  // 收债:账户2=收款方(钱进这里),账户1=原应收户
  收债: { main: '账户2', to: '账户1' },
  负债变更: { main: '账户1', to: null },
};

/** 从备注 `#代付: 刘妈#` 提取对手方名字(借还台账按 merchant 聚合) */
function counterpartyFromRemark(remark, sheetName) {
  if (!remark) return null;
  const m = String(remark).match(new RegExp(`^#\\s*${sheetName}\\s*[:：]\\s*(.+?)\\s*#$`));
  return m ? m[1].slice(0, 60) : null;
}

/** 成员列解析:'宝宝/刘星燎'、'宝宝、刘星燎'、'宝宝 刘星燎' → ['宝宝','刘星燎'] */
function parsePeople(v) {
  return String(v || '')
    .split(/[,，、\/|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((s) => s.slice(0, 20));
}

function parseDatetime(v) {
  const s = String(v || '').trim();
  const m = s.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})[ T]*(\d{1,2}:\d{2}(:\d{2})?)?/);
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  const time = m[4] ? (m[4].split(':').length === 2 ? m[4] + ':00' : m[4]) : '00:00:00';
  return { date, time, full: `${date} ${time}` };
}

/**
 * 解析随手记 workbook(由 xlsx.js parseXlsx 产出)→ 原始行结构
 * 校验至少存在「支出/收入」之一,否则视为非随手记文件
 */
function parseWorkbook(wb) {
  if (!wb || !wb.sheetNames) throw new Error('无效的工作簿');
  const present = wb.sheetNames.filter((n) => SHEET_TYPE[n]);
  if (!wb.sheetNames.includes('支出') && !wb.sheetNames.includes('收入')) {
    throw new Error('不是随手记导出的账本(缺少「支出/收入」工作表)');
  }
  const sheets = {};
  for (const name of present) {
    const rows = wb.sheets[name] || [];
    const header = (rows[0] || []).map((h) => String(h || '').trim());
    const idx = {};
    header.forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i; });
    const body = rows.slice(1).filter((r) => r.join('').trim().length > 0);
    sheets[name] = { header, idx, rows: body };
  }
  return { sheets, present };
}

/**
 * 把工作簿规范化为导入记录
 * @returns {{ records: Array, failedRows: Array<{sheet,row_no,reason}>, sheetStats: Object }}
 * record 字段:
 *   type, amount_cents(带符号语义见 D4), txn_date, source_time, account_hint, to_account_hint,
 *   category_hint(二级), parent_category_hint(一级), people[], merchant, tags_hint[],
 *   note, meta { sheet, row_no, datetime, booker, project, projectCategory, remark, raw: [...] }
 */
function normalizeSsjRecords(parsed) {
  const records = [];
  const failedRows = [];
  const sheetStats = {};

  for (const [sheetName, sheet] of Object.entries(parsed.sheets)) {
    const type = SHEET_TYPE[sheetName];
    const acc = SHEET_ACCOUNTS[sheetName];
    let imported = 0;
    const { idx } = sheet;

    sheet.rows.forEach((row, i) => {
      const rowNo = i + 2; // 表头占第 1 行
      const raw = sheet.header.map((_, ci) => String(row[ci] ?? '').trim());
      const get = (col) => (idx[col] !== undefined ? String(row[idx[col]] ?? '').trim() : '');
      const fail = (reason) => failedRows.push({ sheet: sheetName, row_no: rowNo, reason });

      const dt = parseDatetime(get('日期'));
      const amountText = get('金额');
      const amountCents = parseAmountToCents(amountText);
      if (!dt) { fail('日期无法解析'); return; }
      if (!amountCents) { fail('金额无法解析或为零'); return; }
      const mainAccount = get(acc.main);
      if (!mainAccount) { fail(`缺少账户列「${acc.main}」`); return; }
      const toAccount = acc.to ? get(acc.to) : '';

      // 金额符号:除「负债变更」外均为正数语义;负债变更走 D4 规则(写入时按账户性质取符号)
      const signedCents = type === 'adjust' ? amountCents : Math.abs(amountCents);

      // 成员(可空 → 无参与人)、商家(源数据为空,仅借贷类从备注提取)、项目分类(常量"所有",不入标签)
      const people = parsePeople(get('成员'));
      const remark = get('备注');
      const merchant = counterpartyFromRemark(remark, sheetName) || '';
      const project = get('项目') || '';
      const projectCategory = get('项目分类') || '';
      const booker = get('记账人') || '';
      const cat1 = get('一级分类');
      const cat2 = get('二级分类');
      const currency = get('账户币种') || 'CNY';

      const noteParts = [];
      if (remark) noteParts.push(remark);
      if (booker) noteParts.push(`记账人:${booker}`);

      records.push({
        type,
        amount_cents: signedCents,
        currency,
        txn_date: dt.date,
        source_time: dt.full,
        account_hint: mainAccount,
        to_account_hint: toAccount || null,
        category_hint: cat2 || null,          // 二级分类(日常记账的分类)
        parent_category_hint: cat1 && cat1 !== '收入' ? cat1 : null, // 收入表一级恒为"收入",跳过
        people,
        merchant: merchant || null,
        tags_hint: project ? [project.trim()].filter(Boolean) : [],
        note: noteParts.join(' · ').slice(0, 300) || null,
        adjust: type === 'adjust' ? { rawCents: amountCents, accountHint: mainAccount } : null,
        meta: {
          sheet: sheetName,
          row_no: rowNo,
          datetime: dt.full,
          booker,
          project,
          projectCategory,
          merchant: get('商家'),
          remark,
          raw,
        },
      });
      imported++;
    });
    sheetStats[sheetName] = { total: sheet.rows.length, imported, failed: sheetStats[sheetName]?.failed || 0 };
  }
  // failedRows 计入 sheetStats
  for (const f of failedRows) {
    if (sheetStats[f.sheet]) sheetStats[f.sheet].failed++;
  }
  // 文件内出现序号:同一天同金额同秒的批量录入行,用序号区分指纹(见 design D11)
  const seqMap = new Map();
  for (const r of records) {
    const k = `${r.txn_date}|${r.amount_cents}|${r.source_time}`;
    const n = (seqMap.get(k) || 0) + 1;
    seqMap.set(k, n);
    r.dup_seq = n;
  }
  return { records, failedRows, sheetStats };
}

/** 检测 buffer 是否随手记 xlsx:zip 魔数 + 工作表名匹配 */
function detectSuishouji(wb) {
  const hits = wb.sheetNames.filter((n) => SHEET_TYPE[n]).length;
  return hits >= 3;
}

module.exports = { parseWorkbook, normalizeSsjRecords, detectSuishouji, SHEET_TYPE, SHEET_ACCOUNTS };
