'use strict';
/** 交易：列表 / 记一笔 / 编辑 / 批量操作 / 报销 */
const express = require('express');
const { all, get, run, todayStr, TXN_TYPE_MAP } = require('../db');
const auth = require('../lib/auth');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const u = require('../lib/util');
const att = require('../lib/attachments');

const router = express.Router();

/** 从表单解析出标准记账号 */
function readForm(body) {
  const splits = [];
  const names = [].concat(body.split_name || []);
  const amounts = [].concat(body.split_amount || []);
  names.forEach((n, i) => {
    const amt = u.parseAmountToCents(amounts[i]);
    if (n && amt) splits.push({ member_name: String(n).slice(0, 30), share_cents: amt });
  });
  return {
    type: body.type || 'expense',
    amount_cents: u.parseAmountToCents(body.amount),
    currency: body.currency || 'CNY',
    rate: body.rate ? Number(body.rate) : 1,
    account_id: body.account_id || null,
    to_account_id: body.to_account_id || null,
    category_id: body.category_id || null,
    txn_date: body.txn_date || todayStr(),
    note: body.note || '',
    merchant: body.merchant || '',
    status: body.status || 'cleared',
    is_reimbursable: body.is_reimbursable ? 1 : 0,
    tags: body.tags || '',
    people: body.people || '',
    splits,
    group_id: body.group_id || null,
    source: body.source || 'manual',
  };
}

/** 从查询串解析筛选条件(GET / 与视图共用,design D3) */
function parseFilterQuery(query) {
  const cats = [].concat(query.category_id || []).map(Number).filter(Boolean);
  return {
    type: query.type || '',
    kind: query.kind || '',
    categoryId: cats.length ? cats : null,
    accountId: query.account_id ? Number(query.account_id) : null,
    memberId: query.member_id ? Number(query.member_id) : null,
    personId: query.person_id ? Number(query.person_id) : null,
    tagId: query.tag_id ? Number(query.tag_id) : null,
    source: query.source || '',
    month: query.month || '',
    from: query.from || '',
    to: query.to || '',
    // 兼容旧书签里的 keyword= 参数
    keyword: query.q || query.keyword || '',
    reimbursable: query.reimbursable || '',
    sort: query.sort || 'date_desc',
    page: Number(query.page) || 1,
    pageSize: 40,
  };
}

/* ---------------------------------- 列表 ---------------------------------- */

router.get('/', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const f = parseFilterQuery(req.query);
  const result = txn.listTransactions(ledgerId, f);
  const form = fd.txFormData(ledgerId, req.session.userId);
  // 筛选走势(服务端渲染,design D3):仅当有筛选条件或始终展示?始终按当前条件计算,视图默认收起
  const trend = txn.trendBreakdown(ledgerId, f);
  res.render('transactions', {
    title: '账单明细', activeNav: 'transactions',
    f, result, groups: txn.groupByDate(result.rows), form, trend,
    totalPages: result.pages,
  });
});

/* --------------------------------- 记一笔 --------------------------------- */

router.get('/new', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  // type=salary 是「工资收入」表单模式（非交易类型，落账为按比例拆分的 income，见 design D1）
  const type = req.query.type === 'salary' ? 'salary' : (TXN_TYPE_MAP[req.query.type] ? req.query.type : 'expense');
  const form = fd.txFormData(ledgerId, req.session.userId);
  const prefill = {
    type,
    amount: req.query.amount || '',
    txn_date: req.query.date || todayStr(),
    category_id: req.query.category_id || '',
    account_id: req.query.account_id || (form.accounts[0] ? form.accounts[0].id : ''),
    to_account_id: '',
    note: req.query.note || '',
    merchant: '',
    tags: '',
    is_reimbursable: 0,
    currency: 'CNY',
    rate: 1,
    status: 'cleared',
  };
  if (req.query.from_ai) {
    prefill.note = req.query.note || prefill.note;
  }
  res.render('txn-form', {
    title: '记一笔', activeNav: 'new', mode: 'create', form, t: prefill,
    splitRows: [], splits: [], back: req.query.back || '/transactions',
  });
});

router.post('/', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const data = readForm(req.body);
  const wantsJson = req.body._json === '1' || (req.headers.accept || '').includes('application/json');
  // 工资收入模式（表单隐藏字段 type=salary）：按比例分配到「其他」账户，每账户各生成一笔收入（服务端重算分配，不信任客户端）
  if (req.body.type === 'salary') {
    try {
      const r = txn.createSalaryAllocation(ledgerId, req.session.userId, {
        totalCents: data.amount_cents,
        txn_date: data.txn_date,
        category_id: data.category_id,
        note: data.note,
        tags: data.tags,
        people: data.people,
        source: data.source,
      });
      auth.audit(req, 'txn.create', { entity: 'transaction', entityId: r.ids[0], ledgerId, detail: `工资分配 ${r.parts.length} 笔共 ${(r.total / 100).toFixed(2)}` });
      if (wantsJson) return res.json({ ok: true, ids: r.ids, redirect: '/transactions' });
      res.flash('success', `工资已按比例分配入账 ✓（生成 ${r.parts.length} 笔收入，共 ${(r.total / 100).toFixed(2)}）`);
      return res.redirect(req.body.back || '/transactions');
    } catch (e) {
      if (wantsJson) return res.status(400).json({ ok: false, error: e.message });
      const form = fd.txFormData(ledgerId, req.session.userId);
      return res.status(400).render('txn-form', {
        title: '记一笔', activeNav: 'new', mode: 'create', form,
        t: { ...data, type: 'salary', amount: (data.amount_cents / 100).toFixed(2) },
        splitRows: [], splits: [], back: req.body.back || '/transactions', error: e.message,
      });
    }
  }
  try {
    const id = txn.createTransaction(ledgerId, req.session.userId, data);
    auth.audit(req, 'txn.create', { entity: 'transaction', entityId: id, ledgerId, detail: `${data.type} ${(data.amount_cents / 100).toFixed(2)}` });
    if (wantsJson) return res.json({ ok: true, id, redirect: '/transactions' });
    res.flash('success', '已记一笔 ✓');
    res.redirect(req.body.back || '/transactions');
  } catch (e) {
    if (wantsJson) return res.status(400).json({ ok: false, error: e.message });
    const form = fd.txFormData(ledgerId, req.session.userId);
    res.status(400).render('txn-form', {
      title: '记一笔', activeNav: 'new', mode: 'create', form,
      t: { ...data, amount: (data.amount_cents / 100).toFixed(2) },
      splitRows: data.splits, splits: [], back: req.body.back || '/transactions', error: e.message,
    });
  }
});

/* ---------------------------------- 编辑 ---------------------------------- */

router.get('/:id/edit', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const t = txn.getTransaction(Number(req.params.id), ledgerId);
  if (!t) return res.status(404).render('error', { title: '记录不存在', message: '该笔记录可能已被删除。' });
  const form = fd.txFormData(ledgerId, req.session.userId);
  res.render('txn-form', {
    title: '编辑记录', activeNav: 'transactions', mode: 'edit', form, t,
    splitRows: txn.splitsOf(t.id),
    splits: txn.splitsOf(t.id),
    images: att.listByTxn(t.id),
    back: req.query.back || '/transactions',
  });
});

router.post('/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const data = readForm(req.body);
  try {
    txn.updateTransaction(id, ledgerId, req.session.userId, data);
    auth.audit(req, 'txn.update', { entity: 'transaction', entityId: id, ledgerId });
    res.flash('success', '已保存修改');
    res.redirect(req.body.back || '/transactions');
  } catch (e) {
    const form = fd.txFormData(ledgerId, req.session.userId);
    const t = txn.getTransaction(id, ledgerId);
    res.status(400).render('txn-form', {
      title: '编辑记录', activeNav: 'transactions', mode: 'edit', form,
      t: { ...t, ...data, amount: (data.amount_cents / 100).toFixed(2) },
      splitRows: data.splits, splits: data.splits, back: req.body.back || '/transactions', error: e.message,
    });
  }
});

router.post('/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const ok = txn.softDelete(Number(req.params.id), ledgerId);
  auth.audit(req, 'txn.delete', { entity: 'transaction', entityId: Number(req.params.id), ledgerId });
  if (req.body._json === '1') return res.json({ ok });
  res.flash(ok ? 'success' : 'error', ok ? '已删除' : '记录不存在');
  res.redirect(req.body.back || '/transactions');
});

/* --------------------------------- 批量操作 -------------------------------- */

router.post('/bulk', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action || '';
  if (!ids.length) {
    res.flash('error', '请先勾选记录');
    return res.redirect(req.body.back || '/transactions');
  }
  const placeholders = ids.map(() => '?').join(',');
  switch (action) {
    case 'delete': {
      const n = txn.bulkDelete(ids, ledgerId);
      res.flash('success', `已删除 ${n} 笔记录`);
      break;
    }
    case 'category': {
      const cid = req.body.category_id ? Number(req.body.category_id) : null;
      const c = cid ? get('SELECT id FROM categories WHERE id = ? AND (ledger_id IS NULL OR ledger_id = ?)', cid, ledgerId) : null;
      if (!c) { res.flash('error', '请选择要改成的分类'); break; }
      run(`UPDATE transactions SET category_id = ?, updated_at = ? WHERE ledger_id = ? AND id IN (${placeholders})`, cid, require('../db').nowStr(), ledgerId, ...ids);
      res.flash('success', `已修改 ${ids.length} 笔的分类`);
      break;
    }
    case 'tag': {
      const tag = String(req.body.tag || '').trim();
      if (!tag) { res.flash('error', '请输入标签名'); break; }
      for (const id of ids) txn.applyTags(id, ledgerId, tag, false);
      res.flash('success', `已为 ${ids.length} 笔添加标签「${tag}」`);
      break;
    }
    case 'reimburse': {
      try {
        const r = txn.markReimbursed(ids, ledgerId, req.session.userId, req.body.account_id ? Number(req.body.account_id) : null);
        res.flash('success', `已标记 ${r.count} 笔为已报销，生成入账 ${(r.total / 100).toFixed(2)}`);
      } catch (e) {
        res.flash('error', e.message);
      }
      break;
    }
    case 'reimbursable': {
      run(`UPDATE transactions SET is_reimbursable = 1, updated_at = ? WHERE ledger_id = ? AND id IN (${placeholders})`, require('../db').nowStr(), ledgerId, ...ids);
      res.flash('success', `已标记 ${ids.length} 笔为待报销`);
      break;
    }
    case 'restore': {
      run(`UPDATE transactions SET deleted_at = NULL WHERE ledger_id = ? AND id IN (${placeholders})`, ledgerId, ...ids);
      res.flash('success', '已恢复');
      break;
    }
    default:
      res.flash('error', '未知操作');
  }
  res.redirect(req.body.back || '/transactions');
});

module.exports = router;
