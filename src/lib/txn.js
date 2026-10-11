'use strict';
/** 记账服务层：交易查询、写入、统计聚合 */
const { all, get, run, tx, nowStr, todayStr, TXN_TYPE_MAP, recalcBalances } = require('../db');
const { monthOf, pad, lastMonths, toBase } = require('./util');
const attach = require('./attachments');

/** 计入「收入」统计的类型 */
const INCOME_TYPES = ['income', 'interest', 'refund', 'reimburse'];
/** 计入「支出」统计的类型（转账、借贷、投资不计入，避免虚增） */
const EXPENSE_TYPES = ['expense', 'fee'];

const TXN_SELECT = `
SELECT t.*,
  c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
  pc.name AS category_parent,
  a.name AS account_name, a.icon AS account_icon, a.type AS account_type,
  ta.name AS to_account_name, ta.icon AS to_account_icon,
  u.display_name AS member_name, u.avatar_color AS member_color,
  (SELECT GROUP_CONCAT(tg.name, ' ') FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = t.id) AS tag_names,
  (SELECT GROUP_CONCAT(lp.name, ' ') FROM transaction_participants tp JOIN ledger_people lp ON lp.id = tp.person_id WHERE tp.transaction_id = t.id) AS participant_names
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN categories pc ON pc.id = c.parent_id
LEFT JOIN accounts a ON a.id = t.account_id
LEFT JOIN accounts ta ON ta.id = t.to_account_id
LEFT JOIN users u ON u.id = t.user_id
`;

function decorate(t) {
  if (!t) return t;
  t.type_label = TXN_TYPE_MAP[t.type]?.label || t.type;
  t.type_icon = TXN_TYPE_MAP[t.type]?.icon || '•';
  t.type_color = TXN_TYPE_MAP[t.type]?.color || '#8c8c8c';
  t.flow = TXN_TYPE_MAP[t.type]?.flow || 'out';
  t.category_path = t.category_parent ? `${t.category_parent}/${t.category_name}` : (t.category_name || '未分类');
  t.is_income = INCOME_TYPES.includes(t.type);
  t.is_expense = EXPENSE_TYPES.includes(t.type);
  return t;
}

/* -------------------------------- 查询构建 -------------------------------- */

function buildWhere(ledgerId, f = {}) {
  const where = ['t.ledger_id = ?', 't.deleted_at IS NULL'];
  const params = [ledgerId];

  if (f.types && f.types.length) {
    where.push(`t.type IN (${f.types.map(() => '?').join(',')})`);
    params.push(...f.types);
  } else if (f.type) {
    where.push('t.type = ?');
    params.push(f.type);
  } else if (f.kind === 'expense') {
    where.push(`t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')})`);
    params.push(...EXPENSE_TYPES);
  } else if (f.kind === 'income') {
    where.push(`t.type IN (${INCOME_TYPES.map(() => '?').join(',')})`);
    params.push(...INCOME_TYPES);
  }

  if (f.categoryId) {
    // 支持单选与多选:多选时展开各分类及其子分类,按并集过滤
    const catIds = [].concat(f.categoryId).map(Number).filter(Boolean);
    if (catIds.length === 1) {
      where.push('(t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))');
      params.push(catIds[0], catIds[0]);
    } else if (catIds.length > 1) {
      where.push(`(t.category_id IN (${catIds.map(() => '?').join(',')})
        OR t.category_id IN (SELECT id FROM categories WHERE parent_id IN (${catIds.map(() => '?').join(',')})))`);
      params.push(...catIds, ...catIds);
    }
  }
  if (f.accountId) {
    where.push('(t.account_id = ? OR t.to_account_id = ?)');
    params.push(f.accountId, f.accountId);
  }
  if (f.memberId) { where.push('t.user_id = ?'); params.push(f.memberId); }
  if (f.source) { where.push('t.source = ?'); params.push(f.source); }
  if (f.tagId) {
    where.push('EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag_id = ?)');
    params.push(f.tagId);
  }
  if (f.personId) {
    where.push('EXISTS (SELECT 1 FROM transaction_participants tp WHERE tp.transaction_id = t.id AND tp.person_id = ?)');
    params.push(f.personId);
  }
  if (f.month) {
    where.push("strftime('%Y-%m', t.txn_date) = ?");
    params.push(f.month);
  }
  if (f.from) { where.push('t.txn_date >= ?'); params.push(f.from); }
  if (f.to) { where.push('t.txn_date <= ?'); params.push(f.to); }
  if (f.minCents) { where.push('t.amount_base_cents >= ?'); params.push(f.minCents); }
  if (f.maxCents) { where.push('t.amount_base_cents <= ?'); params.push(f.maxCents); }
  if (f.keyword) {
    // 金额按值匹配:关键词是数字时换算成「分」的精确串(「88.5」命中 8850),其余列继续模糊 LIKE
    const centsStr = /^\d+(\.\d+)?$/.test(String(f.keyword).trim())
      ? String(Math.round(parseFloat(String(f.keyword).trim()) * 100))
      : null;
    const likeCols = ['t.note', 't.merchant', 'c.name', 'pc.name', 'a.name'];
    const kw = `%${f.keyword}%`;
    where.push(`(${likeCols.map((c) => `${c} LIKE ?`).join(' OR ')}${centsStr ? ' OR CAST(t.amount_base_cents AS TEXT) = ?' : ''})`);
    params.push(...likeCols.map(() => kw));
    if (centsStr) params.push(centsStr);
  }
  if (f.reimbursable === 'yes') where.push('t.is_reimbursable = 1 AND t.reimbursed_at IS NULL');
  if (f.reimbursable === 'done') where.push('t.is_reimbursable = 1 AND t.reimbursed_at IS NOT NULL');
  return { sql: where.join(' AND '), params };
}

function listTransactions(ledgerId, f = {}) {
  const { sql, params } = buildWhere(ledgerId, f);
  const pageSize = Math.min(Math.max(Number(f.pageSize) || 30, 1), 200);
  const page = Math.max(Number(f.page) || 1, 1);
  const total = Number(get(`SELECT COUNT(*) AS c FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories pc ON pc.id = c.parent_id WHERE ${sql}`, ...params)?.c || 0);

  const sortMap = {
    date_desc: 't.txn_date DESC, t.id DESC',
    date_asc: 't.txn_date ASC, t.id ASC',
    amount_desc: 't.amount_base_cents DESC',
    amount_asc: 't.amount_base_cents ASC',
  };
  const order = sortMap[f.sort] || sortMap.date_desc;
  const rows = all(
    `${TXN_SELECT} WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize
  ).map(decorate);

  const sum = get(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS income,
       COALESCE(SUM(CASE WHEN t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS expense
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories pc ON pc.id = c.parent_id WHERE ${sql}`,
    ...INCOME_TYPES, ...EXPENSE_TYPES, ...params
  );
  return {
    rows, total, page, pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    sum: { income: Number(sum?.income || 0), expense: Number(sum?.expense || 0) },
  };
}

function groupByDate(rows) {
  const groups = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.date !== r.txn_date) {
      cur = { date: r.txn_date, items: [], income: 0, expense: 0 };
      groups.push(cur);
    }
    cur.items.push(r);
    if (INCOME_TYPES.includes(r.type)) cur.income += Number(r.amount_base_cents);
    if (EXPENSE_TYPES.includes(r.type)) cur.expense += Number(r.amount_base_cents);
  }
  // 给每笔带上「关联了几张账单截图」，列表页据此显示 📎 标记（一次查询，避免 N+1）
  attach.attachCounts(rows);
  return groups;
}

function getTransaction(id, ledgerId) {
  const t = get(`${TXN_SELECT} WHERE t.id = ? AND t.ledger_id = ? AND t.deleted_at IS NULL`, id, ledgerId);
  return decorate(t);
}

/* -------------------------------- 写入逻辑 -------------------------------- */

function pickAccount(ledgerId, id) {
  if (!id) return null;
  const a = get('SELECT id FROM accounts WHERE id = ? AND ledger_id = ?', Number(id), ledgerId);
  return a ? Number(a.id) : null;
}
function pickCategory(ledgerId, id) {
  if (!id) return null;
  const c = get('SELECT id FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)', Number(id), ledgerId);
  return c ? Number(c.id) : null;
}

/**
 * 写入一笔交易
 * @param {object} d 表单数据
 */
function createTransaction(ledgerId, userId, d) {
  const type = TXN_TYPE_MAP[d.type] ? d.type : 'expense';
  const amount = Math.abs(Math.round(Number(d.amount_cents) || 0));
  if (!amount) throw new Error('金额必须大于 0');
  const rate = Number(d.rate) > 0 ? Number(d.rate) : 1;
  const currency = d.currency || 'CNY';
  const accountId = pickAccount(ledgerId, d.account_id);
  const toAccountId = pickAccount(ledgerId, d.to_account_id);
  if (['expense', 'income', 'lend', 'borrow', 'repay_pay', 'repay_receive', 'fee', 'interest'].includes(type) && !accountId) {
    throw new Error('请选择账户');
  }
  if (type === 'transfer' && (!accountId || !toAccountId)) throw new Error('转账需要选择转出与转入账户');
  if (type === 'transfer' && accountId === toAccountId) throw new Error('转出与转入账户不能相同');

  const txnDate = /^\d{4}-\d{2}-\d{2}$/.test(String(d.txn_date || '')) ? d.txn_date : todayStr();
  const info = run(
    `INSERT INTO transactions
     (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
      user_id, txn_date, note, merchant, status, is_reimbursable, group_id, source, ai_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ledgerId, type, amount, currency, rate, toBase(amount, rate), accountId, toAccountId,
    pickCategory(ledgerId, d.category_id), userId, txnDate,
    d.note ? String(d.note).slice(0, 300) : null,
    d.merchant ? String(d.merchant).slice(0, 60) : null,
    d.status === 'pending' ? 'pending' : 'cleared',
    d.is_reimbursable ? 1 : 0,
    d.group_id || null,
    d.source || 'manual',
    d.ai_json || null,
    nowStr(), nowStr()
  );
  const id = info.lastInsertRowid;
  applyTags(id, ledgerId, d.tags);
  applyParticipants(id, ledgerId, d.people);
  if (d.splits && d.splits.length) saveSplits(ledgerId, id, d.group_id, d.splits);
  recalcBalances(ledgerId);
  syncDebts(ledgerId);
  return id;
}

function updateTransaction(id, ledgerId, userId, d) {
  const old = get('SELECT * FROM transactions WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL', id, ledgerId);
  if (!old) throw new Error('记录不存在');
  const type = TXN_TYPE_MAP[d.type] ? d.type : old.type;
  const amount = Math.abs(Math.round(Number(d.amount_cents) || 0));
  if (!amount) throw new Error('金额必须大于 0');
  const rate = Number(d.rate) > 0 ? Number(d.rate) : 1;
  run(
    `UPDATE transactions SET type=?, amount_cents=?, currency=?, rate=?, amount_base_cents=?, account_id=?,
       to_account_id=?, category_id=?, txn_date=?, note=?, merchant=?, status=?, is_reimbursable=?,
       updated_at=? WHERE id=?`,
    type, amount, d.currency || old.currency, rate, toBase(amount, rate),
    pickAccount(ledgerId, d.account_id), pickAccount(ledgerId, d.to_account_id),
    pickCategory(ledgerId, d.category_id),
    /^\d{4}-\d{2}-\d{2}$/.test(String(d.txn_date || '')) ? d.txn_date : old.txn_date,
    d.note ? String(d.note).slice(0, 300) : null,
    d.merchant ? String(d.merchant).slice(0, 60) : null,
    d.status === 'pending' ? 'pending' : 'cleared',
    d.is_reimbursable ? 1 : 0,
    nowStr(), id
  );
  applyTags(id, ledgerId, d.tags, true);
  applyParticipants(id, ledgerId, d.people, true);
  if (d.splits && d.splits.length) saveSplits(ledgerId, id, old.group_id, d.splits);
  recalcBalances(ledgerId);
  syncDebts(ledgerId);
  return id;
}

function softDelete(id, ledgerId) {
  const t = get('SELECT * FROM transactions WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!t) return false;
  run('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?', nowStr(), nowStr(), id);
  if (t.group_id) run('DELETE FROM splits WHERE group_id = ?', t.group_id);
  recalcBalances(ledgerId);
  syncDebts(ledgerId);
  return true;
}

function bulkDelete(ids, ledgerId) {
  let n = 0;
  tx(() => {
    for (const id of ids) if (softDelete(Number(id), ledgerId)) n++;
  });
  return n;
}

/** 报销：把若干笔标记为已报销，并生成一笔报销入账 */
function markReimbursed(ids, ledgerId, userId, accountId) {
  const rows = all(
    `SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    ledgerId, ...ids
  );
  const total = rows.reduce((a, b) => a + Number(b.amount_base_cents), 0);
  if (!rows.length || !total) throw new Error('没有可报销的记录');
  return tx(() => {
    const txnId = createTransaction(ledgerId, userId, {
      type: 'reimburse',
      amount_cents: total,
      account_id: accountId,
      category_id: null,
      txn_date: todayStr(),
      note: `报销 ${rows.length} 笔，合计 ${(total / 100).toFixed(2)}`,
      source: 'manual',
    });
    for (const r of rows) {
      run('UPDATE transactions SET reimbursed_at = ?, related_id = ? WHERE id = ?', nowStr(), txnId, r.id);
    }
    return { txnId, total, count: rows.length };
  });
}

/* ----------------------------- 工资按比例分配 ------------------------------ */

/**
 * 按比例把总金额（分）分配到各账户（整数分精确分配，余数按比例降序、并列取 id 升序逐户补 1 分）。
 * @param {number} totalCents 总金额（分）
 * @param {Array<{id:number, alloc_ratio:number}>} accounts 参与分配的账户（alloc_ratio 0~100）
 * @returns {Array<{account_id:number, cents:number}>} alloc_ratio<=0 的账户不参与
 */
function computeAllocation(totalCents, accounts) {
  const total = Math.round(Number(totalCents) || 0);
  const rows = (accounts || [])
    .map((a) => ({ account_id: Number(a.id), ratio: Math.max(0, Math.min(100, Math.round(Number(a.alloc_ratio) || 0))) }))
    .filter((a) => a.ratio > 0);
  const parts = rows.map((a) => ({ ...a, cents: Math.floor((total * a.ratio) / 100) }));
  const order = [...parts].sort((x, y) => (y.ratio - x.ratio) || (x.account_id - y.account_id));
  let remainder = total - parts.reduce((s, p) => s + p.cents, 0);
  for (let i = 0; remainder > 0 && order.length; i = (i + 1) % order.length) { order[i].cents++; remainder--; }
  return parts;
}

/**
 * 工资收入按比例分配落账：每个「其他」账户各生成一笔收入交易（同组 group_id 串联）。
 * @param {object} p { totalCents, txn_date, category_id, note, tags, people, source }
 */
function createSalaryAllocation(ledgerId, userId, p) {
  const accounts = all(
    `SELECT id, name, alloc_ratio FROM accounts WHERE ledger_id = ? AND type = 'other' AND is_archived = 0 ORDER BY sort_order, id`,
    ledgerId
  );
  if (!accounts.length) throw new Error('账本中没有「其他」类型账户，请先到账户管理创建');
  const sumRatio = accounts.reduce((s, a) => s + (Number(a.alloc_ratio) || 0), 0);
  if (sumRatio !== 100) throw new Error(`分配比例总和为 ${sumRatio}%，必须等于 100%，请到账户管理调整各「其他」账户的比例`);
  const totalCents = Math.round(Number(p.totalCents) || 0);
  if (totalCents <= 0) throw new Error('请输入有效的工资金额');
  const parts = computeAllocation(totalCents, accounts);
  const groupId = `salary-${Date.now()}`;
  return tx(() => {
    const ids = parts.map((part) => createTransaction(ledgerId, userId, {
      type: 'income',
      amount_cents: part.cents,
      account_id: part.account_id,
      category_id: p.category_id ?? null,
      txn_date: p.txn_date,
      note: p.note || null,
      tags: p.tags,
      people: p.people,
      source: p.source || 'manual',
      group_id: groupId,
    }));
    return { ids, parts, total: totalCents };
  });
}

/* ---------------------------------- 标签 ---------------------------------- */

function applyTags(txnId, ledgerId, tagsInput, replace = false) {
  const names = String(tagsInput || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (replace) run('DELETE FROM transaction_tags WHERE transaction_id = ?', txnId);
  if (!names.length) return;
  for (const name of names) {
    let tag = get('SELECT * FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, name);
    if (!tag) {
      const info = run('INSERT INTO tags (ledger_id, name, color) VALUES (?,?,?)', ledgerId, name, colorFromName(name));
      tag = { id: info.lastInsertRowid };
    }
    try { run('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)', txnId, tag.id); } catch { /* ignore */ }
  }
}

function colorFromName(name) {
  const palette = ['#4f7cff', '#13c2c2', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1', '#fa541c'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
  return palette[h % palette.length];
}

/* ------------------------------ 参与成员(自由名单) ----------------------------- */

/** 自由成员 find-or-create:纯名字、按账本隔离、同账本唯一 */
function ensurePerson(ledgerId, name) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return null;
  let p = get('SELECT id FROM ledger_people WHERE ledger_id = ? AND name = ?', ledgerId, n);
  if (!p) {
    const info = run('INSERT INTO ledger_people (ledger_id, name, color, created_at) VALUES (?,?,?,?)', ledgerId, n, colorFromName(n), nowStr());
    p = { id: info.lastInsertRowid };
  }
  return Number(p.id);
}

/** 交易参与成员:空格/逗号分隔,≤8 人;replace 为编辑时的替换语义(与标签一致) */
function applyParticipants(txnId, ledgerId, input, replace = false) {
  const names = String(input || '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (replace) run('DELETE FROM transaction_participants WHERE transaction_id = ?', txnId);
  for (const name of names) {
    const pid = ensurePerson(ledgerId, name);
    if (pid) { try { run('INSERT OR IGNORE INTO transaction_participants (transaction_id, person_id) VALUES (?,?)', txnId, pid); } catch { /* ignore */ } }
  }
}

/* ---------------------------------- 分账 ---------------------------------- */

function saveSplits(ledgerId, txnId, groupId, splits) {
  const gid = groupId || `sp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  run('DELETE FROM splits WHERE group_id = ?', gid);
  for (const s of splits) {
    const share = Math.round(Number(s.share_cents) || 0);
    if (!share) continue;
    run(
      `INSERT INTO splits (group_id, transaction_id, ledger_id, user_id, member_name, share_cents, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      gid, txnId, ledgerId, s.user_id || null, String(s.member_name || '成员').slice(0, 30), share, nowStr()
    );
  }
  run('UPDATE transactions SET group_id = ? WHERE id = ?', gid, txnId);
  return gid;
}

function splitsOf(txnId) {
  return all('SELECT * FROM splits WHERE transaction_id = ? ORDER BY id', txnId);
}

/* ------------------------------- 借贷台账同步 ------------------------------ */

/**
 * 根据借贷类交易自动维护 debts 台账：
 * 代付(lend) → 生成应收；借入(borrow) → 生成应付。同一 (方向, 对手方) 未结清的台账自动累加。
 */
function syncDebts(ledgerId) {
  const rows = all(
    `SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND type IN ('lend','borrow')`,
    ledgerId
  );
  // 已结清台账不重建，简单策略：按 对手方+方向 聚合未结清
  const map = new Map();
  for (const t of rows) {
    const key = `${t.type}|${t.merchant || '未指定'}`;
    const cur = map.get(key) || { direction: t.type === 'lend' ? 'receivable' : 'payable', counterparty: t.merchant || '未指定', principal: 0, account_id: t.account_id, earliest: t.txn_date };
    cur.principal += Number(t.amount_base_cents);
    if (t.txn_date < cur.earliest) cur.earliest = t.txn_date;
    map.set(key, cur);
  }
  // 还款金额
  const repay = new Map();
  for (const t of all(
    `SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND type IN ('repay_receive','repay_pay')`,
    ledgerId
  )) {
    const key = `${t.type === 'repay_receive' ? 'lend' : 'borrow'}|${t.merchant || '未指定'}`;
    repay.set(key, (repay.get(key) || 0) + Number(t.amount_base_cents));
  }
  // 清掉自动生成的（note 标记）再重建
  run("DELETE FROM debts WHERE ledger_id = ? AND note = '系统自动汇总'", ledgerId);
  for (const [key, v] of map) {
    const paid = repay.get(key) || 0;
    const balance = Math.max(0, v.principal - paid);
    run(
      `INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, account_id, status, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ledgerId, v.direction, v.counterparty, v.principal, balance, v.account_id,
      balance <= 0 ? 'closed' : 'open', '系统自动汇总', nowStr()
    );
  }
}

/* --------------------------------- 统计聚合 -------------------------------- */

function rangeOf(month) {
  return { start: `${month}-01`, end: `${month}-31`, month };
}

/** 区间收支合计 */
function summary(ledgerId, start, end) {
  const row = get(
    `SELECT
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense,
      COUNT(*) AS count
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?`,
    ...INCOME_TYPES, ...EXPENSE_TYPES, ledgerId, start, end
  );
  const income = Number(row?.income || 0);
  const expense = Number(row?.expense || 0);
  return { income, expense, net: income - expense, count: Number(row?.count || 0) };
}

/** 按一级分类聚合 */
function categoryBreakdown(ledgerId, start, end, kind = 'expense') {
  const types = kind === 'income' ? INCOME_TYPES : EXPENSE_TYPES;
  const rows = all(
    `SELECT COALESCE(pc.name, c.name, '未分类') AS name,
            COALESCE(pc.icon, c.icon, '🏷️') AS icon,
            COALESCE(pc.color, c.color, '#8c8c8c') AS color,
            SUM(t.amount_base_cents) AS total, COUNT(*) AS cnt
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories pc ON pc.id = c.parent_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
       AND t.type IN (${types.map(() => '?').join(',')})
     GROUP BY COALESCE(pc.name, c.name, '未分类')
     ORDER BY total DESC`,
    ledgerId, start, end, ...types
  );
  return rows.map((r) => ({ ...r, total: Number(r.total), cnt: Number(r.cnt) }));
}

/** 按二级分类聚合（用于下钻） */
function subcategoryBreakdown(ledgerId, start, end, kind = 'expense', topName = null) {
  const types = kind === 'income' ? INCOME_TYPES : EXPENSE_TYPES;
  let sql = `SELECT c.name AS name, c.icon AS icon, c.color AS color, COALESCE(pc.name,'未分类') AS parent,
              SUM(t.amount_base_cents) AS total, COUNT(*) AS cnt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN categories pc ON pc.id = c.parent_id
       WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
         AND t.type IN (${types.map(() => '?').join(',')})`;
  const params = [ledgerId, start, end, ...types];
  if (topName) { sql += ' AND COALESCE(pc.name, c.name) = ?'; params.push(topName); }
  sql += ' GROUP BY c.id ORDER BY total DESC';
  return all(sql, ...params).map((r) => ({ ...r, total: Number(r.total), cnt: Number(r.cnt) }));
}

/** 最近 n 个月收支趋势 */
function monthlyTrend(ledgerId, months = 6, ref = new Date()) {
  const list = lastMonths(months, ref);
  const from = `${list[0]}-01`;
  const to = `${list[list.length - 1]}-31`;
  const rows = all(
    `SELECT strftime('%Y-%m', txn_date) AS m,
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
     GROUP BY m`,
    ...INCOME_TYPES, ...EXPENSE_TYPES, ledgerId, from, to
  );
  const map = new Map(rows.map((r) => [r.m, r]));
  return list.map((m) => {
    const r = map.get(m) || { income: 0, expense: 0 };
    return { month: m, income: Number(r.income), expense: Number(r.expense) };
  });
}

/** 按成员聚合 */
function memberBreakdown(ledgerId, start, end) {
  return all(
    `SELECT u.id, u.display_name AS name, u.avatar_color AS color,
       COALESCE(SUM(CASE WHEN t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS expense,
       COALESCE(SUM(CASE WHEN t.type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS income,
       COUNT(*) AS cnt
     FROM transactions t JOIN users u ON u.id = t.user_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
     GROUP BY u.id ORDER BY expense DESC`,
    ...EXPENSE_TYPES, ...INCOME_TYPES, ledgerId, start, end
  ).map((r) => ({ ...r, expense: Number(r.expense), income: Number(r.income), cnt: Number(r.cnt) }));
}

/** 按标签聚合（kind=expense|income；未打标签的交易归入「未打标签」行） */
/* ------------------------------ 筛选走势聚合 ------------------------------- */

const TREND_PALETTE = ['#4f7cff', '#13c2c2', '#fa8c16', '#eb2f96', '#722ed1', '#52c41a', '#fa541c', '#1677ff'];

/**
 * 筛选结果时间走势(design D3):粒度自动适配——范围 ≤31 天按日,否则按月;
 * f.categoryId 多选时每个分类一条线(≤8,按金额取前 8),未选分类时支出/收入两条。
 * @returns {{grain:string, start:string, end:string, labels:string[], series:Array<{name,color,data:number[]}>}}
 */
function trendBreakdown(ledgerId, f = {}) {
  const today = todayStr();
  let start = f.from || (f.month ? `${f.month}-01` : null);
  let end = f.to || today;
  if (!f.to && f.month) {
    // 单月筛选:终点取真实月末,而非今天(否则跨度被拉长、粒度误判)
    const [my, mm] = f.month.split('-').map(Number);
    end = `${f.month}-${pad(new Date(my, mm, 0).getDate())}`;
  }
  if (!start) {
    start = get('SELECT MIN(txn_date) AS d FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL', ledgerId)?.d || `${today.slice(0, 7)}-01`;
  }
  if (start > end) start = end;
  const spanDays = Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000);
  const byDay = spanDays <= 31;
  const fmt = byDay ? '%Y-%m-%d' : '%Y-%m';

  // 完整桶序列(零填充):日粒度逐日、月粒度逐月
  const buckets = [];
  if (byDay) {
    const [y, m, d] = start.split('-').map(Number);
    const cur = new Date(y, m - 1, d);
    const key = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    while (key(cur) <= end) { buckets.push(key(cur)); cur.setDate(cur.getDate() + 1); }
  } else {
    let [y, m] = start.slice(0, 7).split('-').map(Number);
    const [ey, em] = end.slice(0, 7).split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) { buckets.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
  }

  const { sql, params } = buildWhere(ledgerId, f);
  const from = 'FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories pc ON pc.id = c.parent_id';
  const catIds = [].concat(f.categoryId || []).map(Number).filter(Boolean);
  const series = [];

  if (catIds.length) {
    // 每个筛选对象一条线;子分类金额归并到所选父分类(与列表过滤「含子分类」语义一致);超过 8 条取金额前 8
    const rows = all(
      `SELECT strftime('${fmt}', t.txn_date) AS bucket, t.category_id AS cid, SUM(t.amount_base_cents) AS s
       ${from} WHERE ${sql} GROUP BY bucket, cid`,
      ...params
    );
    const catRows = all('SELECT id, parent_id FROM categories WHERE ledger_id = ?', ledgerId);
    const parentOf = new Map(catRows.map((c) => [Number(c.id), Number(c.parent_id) || 0]));
    const resolveCat = (cid) => {
      let cur = cid;
      for (let hop = 0; hop < 2 && cur; hop++) {
        if (catIds.includes(cur)) return cur;
        cur = parentOf.get(cur) || 0;
      }
      return 0;
    };
    const totals = new Map();
    const cell = new Map();
    for (const r of rows) {
      const target = resolveCat(Number(r.cid));
      if (!target) continue;
      const k = `${r.bucket}|${target}`;
      cell.set(k, (cell.get(k) || 0) + (Number(r.s) || 0));
      totals.set(target, (totals.get(target) || 0) + (Number(r.s) || 0));
    }
    let picked = [...catIds];
    if (picked.length > 8) picked.sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0)).slice(0, 8);
    const catInfo = new Map(
      all(`SELECT id, name, color FROM categories WHERE id IN (${picked.map(() => '?').join(',')})`, ...picked)
        .map((c) => [Number(c.id), c])
    );
    picked.forEach((cid, i) => {
      const info = catInfo.get(cid) || { name: '未知分类', color: null };
      series.push({
        name: info.name,
        color: info.color || TREND_PALETTE[i % TREND_PALETTE.length],
        data: buckets.map((b) => Math.abs(cell.get(`${b}|${cid}`) || 0)),
      });
    });
  } else {
    // 未选具体分类:支出/收入两条
    const rows = all(
      `SELECT strftime('${fmt}', t.txn_date) AS bucket,
         COALESCE(SUM(CASE WHEN t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS e,
         COALESCE(SUM(CASE WHEN t.type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS i
       ${from} WHERE ${sql} GROUP BY bucket`,
      ...EXPENSE_TYPES, ...INCOME_TYPES, ...params
    );
    const map = new Map(rows.map((r) => [r.bucket, r]));
    series.push({ name: '支出', color: '#f5222d', data: buckets.map((b) => Math.abs(Number(map.get(b)?.e) || 0)) });
    series.push({ name: '收入', color: '#52c41a', data: buckets.map((b) => Math.abs(Number(map.get(b)?.i) || 0)) });
  }

  return { grain: byDay ? 'day' : 'month', start, end, labels: buckets, series };
}

function tagBreakdown(ledgerId, start, end, kind = 'expense') {
  const types = kind === 'income' ? INCOME_TYPES : EXPENSE_TYPES;
  return all(
    `SELECT COALESCE(tg.name, '未打标签') AS name, COALESCE(tg.color, '#8c8c8c') AS color,
       SUM(t.amount_base_cents) AS total, COUNT(*) AS cnt
     FROM transactions t
     LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
     LEFT JOIN tags tg ON tg.id = tt.tag_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
       AND t.type IN (${types.map(() => '?').join(',')})
     GROUP BY COALESCE(tg.name, '未打标签') ORDER BY total DESC`,
    ledgerId, start, end, ...types
  ).map((r) => ({ ...r, total: Number(r.total), cnt: Number(r.cnt) }));
}

/** 按参与成员聚合(无参与人的交易归入「无参与人」行;多参与人交易在每人名下各计一次) */
function participantBreakdown(ledgerId, start, end) {
  return all(
    `SELECT lp.id, COALESCE(lp.name, '无参与人') AS name, COALESCE(lp.color, '#8c8c8c') AS color,
       COALESCE(SUM(CASE WHEN t.type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS expense,
       COALESCE(SUM(CASE WHEN t.type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN t.amount_base_cents ELSE 0 END),0) AS income,
       COUNT(DISTINCT t.id) AS cnt
     FROM transactions t
     LEFT JOIN transaction_participants tp ON tp.transaction_id = t.id
     LEFT JOIN ledger_people lp ON lp.id = tp.person_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
     GROUP BY lp.id ORDER BY expense DESC`,
    ...EXPENSE_TYPES, ...INCOME_TYPES, ledgerId, start, end
  ).map((r) => ({ ...r, expense: Number(r.expense), income: Number(r.income), cnt: Number(r.cnt) }));
}

/** 每日聚合（日历/趋势） */
function dailyBreakdown(ledgerId, start, end) {
  return all(
    `SELECT txn_date AS date,
      COALESCE(SUM(CASE WHEN type IN (${EXPENSE_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS expense,
      COALESCE(SUM(CASE WHEN type IN (${INCOME_TYPES.map(() => '?').join(',')}) THEN amount_base_cents ELSE 0 END),0) AS income,
      COUNT(*) AS count
     FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
     GROUP BY txn_date ORDER BY txn_date`,
    ...EXPENSE_TYPES, ...INCOME_TYPES, ledgerId, start, end
  ).map((r) => ({ date: r.date, expense: Number(r.expense), income: Number(r.income), count: Number(r.count) }));
}

/** 账户概览 */
function accountOverview(ledgerId) {
  const accounts = all('SELECT * FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id', ledgerId);
  const LIABILITY = ['credit', 'loan', 'payable'];
  let assets = 0, liabilities = 0;
  for (const a of accounts) {
    const b = Number(a.balance_cents);
    if (LIABILITY.includes(a.type)) liabilities += Math.abs(Math.min(b, 0)) || Math.abs(b);
    else if (b > 0) assets += b;
  }
  const net = accounts.filter((a) => a.include_in_net).reduce((s, a) => s + Number(a.balance_cents), 0);
  return { accounts, assets, liabilities, net };
}

/** 累计净支出（用于净资产走势的近似） */
function netWorthTrend(ledgerId, months = 6, ref = new Date()) {
  const list = lastMonths(months, ref);
  const allTxns = all(
    `SELECT txn_date, type, amount_base_cents, account_id, to_account_id FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date <= ? ORDER BY txn_date`,
    ledgerId, `${list[list.length - 1]}-31`
  );
  const accounts = all('SELECT id, initial_cents FROM accounts WHERE ledger_id = ?', ledgerId);
  const initial = accounts.reduce((s, a) => s + Number(a.initial_cents), 0);
  const { txnEffects } = require('../db');
  const out = [];
  let cum = initial;
  let idx = 0;
  for (const m of list) {
    const end = `${m}-31`;
    while (idx < allTxns.length && allTxns[idx].txn_date <= end) {
      for (const e of txnEffects(allTxns[idx])) cum += e.delta;
      idx++;
    }
    out.push({ month: m, value: cum });
  }
  return out;
}

module.exports = {
  INCOME_TYPES, EXPENSE_TYPES, TXN_SELECT, decorate,
  listTransactions, groupByDate, getTransaction,
  createTransaction, updateTransaction, softDelete, bulkDelete, markReimbursed,
  computeAllocation, createSalaryAllocation,
  applyTags, saveSplits, splitsOf,
  summary, categoryBreakdown, subcategoryBreakdown, monthlyTrend, memberBreakdown,
  tagBreakdown, participantBreakdown, applyParticipants, ensurePerson,
  trendBreakdown,
  dailyBreakdown, accountOverview, netWorthTrend, rangeOf, syncDebts,
};
