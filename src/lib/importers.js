'use strict';
/**
 * 账单导入 / 导出
 *  - 支付宝账单 CSV(GBK 编码,含表头说明行)
 *  - 微信支付账单 CSV(UTF-8)
 *  - 通用 CSV(按表头智能匹配)
 *  - 随手记 xlsx 账本(多工作表,见 importers-suishouji.js)
 * 自动识别编码、自动映射分类与账户、自动去重
 */
const { all, get, run, tx, nowStr, todayStr, recalcBalances, ACCOUNT_TYPE_MAP, TXN_TYPE_MAP } = require('../db');
const { parseAmountToCents, monthOf } = require('./util');
const { classifyByKeywords, guessAccountName, resolveCategoryId, resolveAccountId } = require('./ai');
const xlsx = require('./xlsx');
const ssj = require('./importers-suishouji');

/* ------------------------------- 编码与 CSV ------------------------------- */

/** 支付宝导出为 GBK,微信为 UTF-8:先按 UTF-8 解,出现替换字符则按 GBK 重解 */
function decodeBuffer(buf) {
  const tryDecode = (enc) => {
    try { return new TextDecoder(enc, { fatal: false }).decode(buf); } catch { return null; }
  };
  const utf8 = tryDecode('utf-8');
  if (utf8 && !utf8.includes('�')) return { text: utf8.replace(/^﻿/, ''), encoding: 'utf-8' };
  const gbk = tryDecode('gbk') || tryDecode('gb18030');
  if (gbk) return { text: gbk.replace(/^﻿/, ''), encoding: 'gbk' };
  return { text: utf8 || '', encoding: 'utf-8' };
}

/** 支持引号包裹与转义的 CSV 行解析 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map(parseCsvLine);
}

const HEADER_KEYS = ['交易时间', '交易分类', '交易类型', '金额', '收/支', '收/付款方式', '支付方式', '日期', '时间', 'amount', 'date'];

function isHeaderRow(cells) {
  const joined = cells.join(',');
  return HEADER_KEYS.some((k) => joined.includes(k)) && cells.length >= 4;
}

/** 表头名 → 索引(支持模糊) */
function headerIndex(header, candidates) {
  for (const c of candidates) {
    const i = header.findIndex((h) => h === c);
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const i = header.findIndex((h) => h && h.includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

function detectSource(headerLine, fullText) {
  const h = headerLine.join(',');
  if (h.includes('交易分类') || /支付宝/.test(fullText.slice(0, 2000))) return 'alipay';
  if (h.includes('交易类型') || h.includes('当前状态') || /微信/.test(fullText.slice(0, 2000))) return 'wechat';
  return 'generic';
}

/* ------------------------------- 单条规范化 ------------------------------- */

const SKIP_STATUS = /已关闭|交易关闭|已退款|全额退款|退款成功|失败|已撤销|已取消|待付款|待收货|银行处理中|已退回/;

function normalizeRow({ date, direction, amountText, merchant, desc, categoryText, accountText, status, orderNo }) {
  const amountCents = parseAmountToCents(amountText);
  const dir = String(direction || '').trim();
  let type = 'expense';
  let neutral = false;
  if (/不计/.test(dir)) {
    // 转账 / 提现 / 充值 等「不计收支」记录:默认不导入(成对记录只导一半会破坏余额)
    type = 'transfer';
    neutral = true;
  } else if (/收入|收/.test(dir)) type = 'income';
  else if (/支出|支/.test(dir)) type = 'expense';
  const text = `${categoryText || ''} ${desc || ''} ${merchant || ''}`;
  return {
    skip: false,
    neutral,
    type,
    amount_cents: amountCents,
    txn_date: normalizeDate(date),
    merchant: (merchant || desc || '').slice(0, 60) || null,
    note: [categoryText, desc, status].filter(Boolean).join(' · ').slice(0, 200) || null,
    category_hint: categoryText || null,
    text,
    account_hint: accountText || guessAccountName(text) || null,
    order_no: orderNo || null,
  };
}

function normalizeDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/(20\d{2})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](20\d{2})/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return todayStr();
}

/* --------------------------------- 主解析器 -------------------------------- */

function parseBill(buffer) {
  const { text, encoding } = decodeBuffer(buffer);
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex(isHeaderRow);
  if (headerIdx < 0) {
    return { source: 'unknown', encoding, header: [], records: [], totalLines: rows.length, error: '未找到有效表头,请确认为支付宝/微信导出的 CSV 账单' };
  }
  const header = rows[headerIdx];
  const source = detectSource(header, text);
  const body = rows.slice(headerIdx + 1).filter((r) => r.length > 2 && r.join('').replace(/[-,\s]/g, '').length > 0);

  const iDate = headerIndex(header, ['交易时间', '交易日期', '日期', '时间', 'date']);
  const iDir = headerIndex(header, ['收/支', '收支', '类型', '方向']);
  const iAmount = headerIndex(header, ['金额(元)', '金额', 'amount']);
  const iMerchant = headerIndex(header, ['交易对方', '对方', 'merchant', '商家']);
  const iDesc = headerIndex(header, ['商品说明', '商品', '备注', '描述', '说明', 'note', 'detail']);
  const iCategory = headerIndex(header, ['交易分类', '分类', 'category']);
  const iAccount = headerIndex(header, ['收/付款方式', '支付方式', '付款方式', '账户', 'account']);
  const iStatus = headerIndex(header, ['当前状态', '交易状态', '状态', 'status']);
  const iOrder = headerIndex(header, ['交易订单号', '交易单号', '订单号', 'order']);

  const records = [];
  const neutralRecords = []; // 提现 / 充值 / 余额宝转出等「不计收支」记录,默认不入库
  let skipped = 0;
  for (const r of body) {
    const status = iStatus >= 0 ? r[iStatus] : '';
    if (status && SKIP_STATUS.test(status)) { skipped++; continue; }
    const norm = normalizeRow({
      date: iDate >= 0 ? r[iDate] : '',
      direction: iDir >= 0 ? r[iDir] : '',
      amountText: iAmount >= 0 ? r[iAmount] : '',
      merchant: iMerchant >= 0 ? r[iMerchant] : '',
      desc: iDesc >= 0 ? r[iDesc] : '',
      categoryText: iCategory >= 0 ? r[iCategory] : '',
      accountText: iAccount >= 0 ? r[iAccount] : '',
      status,
      orderNo: iOrder >= 0 ? r[iOrder] : '',
    });
    if (norm.skip || !norm.amount_cents) { skipped++; continue; }
    if (norm.neutral) neutralRecords.push(norm);
    else records.push(norm);
  }
  return { source, encoding, header, records, neutralRecords, totalLines: rows.length, skipped };
}

/* ----------------------------- 随手记 xlsx 解析 ---------------------------- */

/**
 * 解析随手记 xlsx 账本 → 与 parseBill 同构的结果(records 直接可用于 importRecords)
 * 非 zip 或非随手记结构时抛出带说明的 Error
 */
function parseSuishouji(buffer) {
  const wb = xlsx.parseXlsx(buffer);
  const parsed = ssj.parseWorkbook(wb);
  if (!ssj.detectSuishouji({ sheetNames: parsed.present })) {
    throw new Error('这是 Excel 文件,但不是随手记导出的账本(缺少随手记工作表)');
  }
  const norm = ssj.normalizeSsjRecords(parsed);
  for (const r of norm.records) r.ssj = true;
  return {
    source: 'suishouji',
    records: norm.records,
    neutralRecords: [],
    failedRows: norm.failedRows,
    sheetStats: norm.sheetStats,
    sheetNames: parsed.present,
    skipped: 0,
    totalLines: norm.records.length + norm.failedRows.length,
  };
}

/** 格式路由:zip 魔数 → 随手记 xlsx;否则走 CSV */
function detectFormat(buffer, fileName) {
  if (xlsx.looksLikeXlsx(buffer)) return 'suishouji-candidate';
  return 'csv';
}

/* --------------------------------- 执行导入 -------------------------------- */

/** 账户类型推断:先债项(应收/应付),再支付工具,最后资金池 */
function inferAccountType(name) {
  const n = String(name || '');
  if (/欠款$/.test(n)) return 'receivable';   // 刘妈欠款 / 刘志杰欠款:别人欠我
  if (/^欠/.test(n)) return 'payable';        // 欠工商银行 / 欠润辛妈:我欠别人
  if (/信用|花呗|贷记/.test(n)) return 'credit';
  if (/支付宝|微信|京东|云闪付/.test(n)) return 'virtual';
  if (/定期|理财|股票|证券|投资/.test(n)) return 'investment';
  if (/银行|卡/.test(n)) return 'debit';
  return 'other';
}

function ensureAccount(ledgerId, name, createdList) {
  if (!name) return null;
  const id = resolveAccountId(ledgerId, name);
  if (id) return id;
  const type = inferAccountType(name);
  const icon = type === 'credit' ? '💳' : type === 'virtual' ? '📱' : type === 'debit' ? '🏦'
    : type === 'receivable' ? '📥' : type === 'payable' ? '📤' : type === 'investment' ? '📈' : '📦';
  const r = run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at)
     VALUES (?,?,?,?,?,0,0,999,?,?)`,
    ledgerId, String(name).slice(0, 30), type, icon, 'CNY', '由账单导入自动创建', nowStr()
  );
  createdList.push(name);
  return r.lastInsertRowid;
}

/** 分类 find-or-create:支持「一级/二级」两级;收入表一级为常量时传 null */
function ensureCategory(ledgerId, kind, parentName, childName, createdList) {
  let parentId = null;
  if (parentName) {
    let p = get(
      'SELECT id FROM categories WHERE ledger_id = ? AND kind = ? AND name = ? AND parent_id IS NULL',
      ledgerId, kind, parentName
    );
    if (!p) p = get(
      'SELECT id FROM categories WHERE ledger_id IS NULL AND kind = ? AND name = ? AND parent_id IS NULL',
      kind, parentName
    );
    if (!p) {
      const r = run(
        'INSERT INTO categories (ledger_id, name, kind, icon, color, sort_order) VALUES (?,?,?,?,?,?)',
        ledgerId, parentName.slice(0, 30), kind, '📁', '#8c8c8c', 900
      );
      p = { id: r.lastInsertRowid };
      if (createdList) createdList.push(`${parentName}`);
    }
    parentId = Number(p.id);
  }
  const name = (childName || parentName || '').trim();
  if (!name) return null;
  let c = parentId
    ? get('SELECT id FROM categories WHERE ledger_id = ? AND kind = ? AND name = ? AND parent_id = ?', ledgerId, kind, name, parentId)
    : get('SELECT id FROM categories WHERE (ledger_id = ? OR ledger_id IS NULL) AND kind = ? AND name = ? AND parent_id IS NULL', ledgerId, kind, name);
  if (!c) {
    const r = run(
      'INSERT INTO categories (ledger_id, name, kind, parent_id, icon, color, sort_order) VALUES (?,?,?,?,?,?,?)',
      ledgerId, name.slice(0, 30), kind, parentId, '🏷️', '#8c8c8c', 901
    );
    c = { id: r.lastInsertRowid };
    if (createdList) createdList.push(parentId ? `${parentName}/${name}` : name);
  }
  return Number(c.id);
}

function ensureTag(ledgerId, name) {
  const n = String(name || '').trim().slice(0, 30);
  if (!n) return null;
  let t = get('SELECT id FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, n);
  if (!t) {
    const r = run('INSERT INTO tags (ledger_id, name) VALUES (?,?)', ledgerId, n);
    t = { id: r.lastInsertRowid };
  }
  return Number(t.id);
}

/** 自由成员 find-or-create(带 name→id 缓存,导入批量场景每个新名字只写一次) */
function ensurePerson(ledgerId, name, cache, createdList) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return null;
  if (cache && cache.has(n)) return cache.get(n);
  let p = get('SELECT id FROM ledger_people WHERE ledger_id = ? AND name = ?', ledgerId, n);
  if (!p) {
    const r = run('INSERT INTO ledger_people (ledger_id, name, created_at) VALUES (?,?,?)', ledgerId, n, nowStr());
    p = { id: r.lastInsertRowid };
    if (createdList) createdList.push(n);
  }
  const id = Number(p.id);
  if (cache) cache.set(n, id);
  return id;
}

/** 「不计收支」记录(提现/充值)找不到对方账户时使用的兜底账户,保证转账双边平衡 */
const NEUTRAL_FALLBACK_ACCOUNT = '外部往来账户';

/**
 * 把解析结果写入数据库
 * @param {object} o
 * @param {boolean} [o.includeNeutral] 是否同时导入「不计收支」记录(提现 / 充值等)
 * @returns {{imported:number, skipped:number, failed:number, createdAccounts:string[], createdPeople:string[], failedRows:Array, jobId:number}}
 */
function importRecords({
  ledgerId, userId, records, neutralRecords = [], includeNeutral = false,
  source, fileName, autoCreateAccount = true, defaultAccountId = null,
  failedRows = [], sheetStats = null,
}) {
  const createdAccounts = [];
  const createdPeople = [];
  let imported = 0, skipped = 0, failed = 0;
  const list = includeNeutral ? records.concat(neutralRecords) : records.slice();
  const dupSet = new Set();
  // 预载已有记录指纹:随手记行按「日期|金额|源时间」,其余按「日期|金额|商家」
  for (const t of all(
    'SELECT txn_date, amount_base_cents, merchant, ai_json FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND source = ?',
    ledgerId, 'import'
  )) {
    dupSet.add(`${t.txn_date}|${t.amount_base_cents}|${t.merchant || ''}`);
    let j = null;
    try { j = JSON.parse(t.ai_json || 'null'); } catch { /* 忽略坏 JSON */ }
    if (j && j.source === 'suishouji' && j.datetime) {
      dupSet.add(`${t.txn_date}|${t.amount_base_cents}|${j.datetime}#${j.dup_seq || 1}`);
    }
  }
  const peopleCache = new Map(
    all('SELECT id, name FROM ledger_people WHERE ledger_id = ?', ledgerId).map((r) => [r.name, Number(r.id)])
  );

  tx(() => {
    for (const rec of list) {
      try {
        let categoryId = null;
        let toAccountId = null;
        const accountId = autoCreateAccount
          ? ensureAccount(ledgerId, rec.account_hint, createdAccounts)
          : resolveAccountId(ledgerId, rec.account_hint) || defaultAccountId;
        if (rec.ssj && !accountId) {
          // 随手记记录必须落到账户上;CSV 路径保持旧行为(允许空账户)
          failed++;
          continue;
        }

        let amount = rec.amount_cents;
        let dupKeyExtra = rec.merchant || '';
        if (rec.ssj) {
          // 随手记记录:类型/账户/分类/标签/成员全量结构化信息
          if (rec.adjust) {
            // 负债变更符号规则(D4):负债性质账户存 -raw(带符号取反),资产账户存 raw
            const accType = accountId ? String(get('SELECT type FROM accounts WHERE id = ?', accountId)?.type || 'other') : 'other';
            const nature = (ACCOUNT_TYPE_MAP[accType] || {}).nature || 'asset';
            amount = nature === 'liability' ? -rec.adjust.rawCents : rec.adjust.rawCents;
          }
          const kind = rec.type === 'income' ? 'income' : 'expense';
          if (rec.category_hint || rec.parent_category_hint) {
            categoryId = ensureCategory(ledgerId, kind, rec.parent_category_hint, rec.category_hint);
          }
          dupKeyExtra = `${rec.source_time || rec.meta?.datetime || ''}#${rec.dup_seq || 1}`;
        } else if (rec.neutral) {
          // 提现 / 充值:账户之间搬钱,不计入收支。对方账户优先从说明文字推断
          const cpName = guessAccountName(rec.text) || NEUTRAL_FALLBACK_ACCOUNT;
          toAccountId = autoCreateAccount
            ? ensureAccount(ledgerId, cpName, createdAccounts) || ensureAccount(ledgerId, NEUTRAL_FALLBACK_ACCOUNT, createdAccounts)
            : resolveAccountId(ledgerId, cpName) || null;
        } else {
          const kind = rec.type === 'income' ? 'income' : 'expense';
          const kw = classifyByKeywords(rec.text);
          if (rec.category_hint) categoryId = resolveCategoryId(ledgerId, rec.category_hint, kind);
          if (!categoryId && kw) categoryId = resolveCategoryId(ledgerId, kw.category, kw.kind === 'income' ? 'income' : kind);
          if (!categoryId) categoryId = resolveCategoryId(ledgerId, kind === 'income' ? '其他收入' : '其他支出', kind);
        }

        if (rec.to_account_hint) {
          toAccountId = autoCreateAccount ? ensureAccount(ledgerId, rec.to_account_hint, createdAccounts) : resolveAccountId(ledgerId, rec.to_account_hint);
        }

        const fp = `${rec.txn_date}|${amount}|${dupKeyExtra}`;
        if (dupSet.has(fp)) { skipped++; continue; }

        const aiJson = rec.ssj
          ? JSON.stringify({
              source: 'suishouji',
              sheet: rec.meta.sheet,
              row_no: rec.meta.row_no,
              datetime: rec.meta.datetime,
              dup_seq: rec.dup_seq || 1,
              booker: rec.meta.booker,
              project: rec.meta.project,
              projectCategory: rec.meta.projectCategory,
              merchant: rec.meta.merchant || undefined,
              remark: rec.meta.remark || undefined,
              raw: rec.meta.raw,
            })
          : JSON.stringify({ source, order_no: rec.order_no, neutral: !!rec.neutral });

        const info = run(
          `INSERT INTO transactions
           (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
            user_id, txn_date, note, merchant, status, source, ai_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ledgerId, rec.type, amount, rec.currency || 'CNY', 1, amount,
          accountId, toAccountId, categoryId, userId, rec.txn_date, rec.note, rec.merchant,
          'cleared', 'import', aiJson,
          nowStr(), nowStr()
        );
        const txnId = Number(info.lastInsertRowid);

        // 标签(项目 → 标签)与参与成员(成员列 → 参与成员)
        if (rec.ssj) {
          for (const tagName of rec.tags_hint || []) {
            const tagId = ensureTag(ledgerId, tagName);
            if (tagId) run('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)', txnId, tagId);
          }
          for (const personName of rec.people || []) {
            const pid = ensurePerson(ledgerId, personName, peopleCache, createdPeople);
            if (pid) run('INSERT OR IGNORE INTO transaction_participants (transaction_id, person_id) VALUES (?,?)', txnId, pid);
          }
        }

        dupSet.add(fp);
        imported++;
      } catch {
        failed++;
      }
    }
  });

  // 导入是直接写表,必须重算账户余额,否则余额与流水不一致
  if (imported > 0) {
    recalcBalances(ledgerId);
    // 代付/借入记录 → 重建借还台账
    require('./txn').syncDebts(ledgerId);
  }

  const failedRowsOut = failedRows;
  const messageParts = [];
  if (createdAccounts.length) messageParts.push(`自动创建账户:${createdAccounts.join('、')}`);
  if (createdPeople.length) messageParts.push(`自动创建参与成员:${createdPeople.join('、')}`);
  if (failedRows.length) messageParts.push(`失败明细:${JSON.stringify(failedRows.slice(0, 50))}`);
  const job = run(
    `INSERT INTO import_jobs (ledger_id, user_id, source, file_name, total, imported, skipped, failed, status, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, userId, source, fileName, list.length, imported, skipped, failed, 'done',
    messageParts.join(';').slice(0, 2000) || null, nowStr()
  );
  return { imported, skipped, failed, createdAccounts, createdPeople, failedRows: failedRowsOut, sheetStats, jobId: job.lastInsertRowid };
}

/* --------------------------------- 导出 ---------------------------------- */

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  // 加 BOM 让 Excel 正确识别 UTF-8
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const EXPORT_HEADER = ['日期', '类型', '金额', '币种', '折算金额', '分类', '账户', '转入账户', '成员', '参与成员', '商家', '备注', '标签', '来源', '状态'];

function exportRows(ledgerId, rows) {
  return rows.map((t) => [
    t.txn_date, t.type_label || t.type, (t.amount_cents / 100).toFixed(2), t.currency,
    (t.amount_base_cents / 100).toFixed(2), t.category_path || '', t.account_name || '',
    t.to_account_name || '', t.member_name || '', t.participant_names || '', t.merchant || '', t.note || '',
    t.tag_names || '', t.source, t.status,
  ]);
}

module.exports = {
  parseBill, parseSuishouji, detectFormat, importRecords, toCsv, csvEscape,
  EXPORT_HEADER, exportRows, decodeBuffer, normalizeDate,
  inferAccountType, ensureAccount, ensureCategory, ensureTag, ensurePerson,
};
