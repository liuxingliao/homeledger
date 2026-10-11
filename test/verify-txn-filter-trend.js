'use strict';
/**
 * 回归:交易明细筛选修复 + 筛选走势图
 * A. lib 层(独立库):金额按值搜索、分类多选并集(含子分类)、trendBreakdown 粒度与聚合
 * B. HTTP 端到端(需 8099 隔离实例,run-all 负责):条件保持(hidden 字段/翻页 q=)、
 *    多选分类、标签下拉、走势图渲染与图例交互属性
 * 运行:node test/verify-txn-filter-trend.js
 */
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

const DATA = path.join(__dirname, '..', 'data-verify-tft');
process.env.DATA_DIR = DATA;
fs.rmSync(DATA, { recursive: true, force: true });

const db = require('../src/db');
const txn = require('../src/lib/txn');

(async () => {
  console.log('\n=== A. 筛选与走势(lib)===\n');

  db.init();
  const userId = db.run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)',
    'tftest', 'x', '筛选测试', db.nowStr()).lastInsertRowid;
  const ledgerId = db.run('INSERT INTO ledgers (name, owner_id, created_at) VALUES (?,?,?)',
    '筛选测试账本', userId, db.nowStr()).lastInsertRowid;
  const accId = db.run('INSERT INTO accounts (ledger_id, name, type, created_at) VALUES (?,?,?,?)',
    ledgerId, '测试账户', 'debit', db.nowStr()).lastInsertRowid;
  const catFood = db.run("INSERT INTO categories (ledger_id, name, kind, icon) VALUES (?,?, 'expense', '🍜')", ledgerId, '餐饮').lastInsertRowid;
  const catFoodChild = db.run("INSERT INTO categories (ledger_id, name, kind, icon, parent_id) VALUES (?,?, 'expense', '🍚', ?)", ledgerId, '早饭', catFood).lastInsertRowid;
  const catTraffic = db.run("INSERT INTO categories (ledger_id, name, kind, icon) VALUES (?,?, 'expense', '🚇')", ledgerId, '交通').lastInsertRowid;
  const tagId = db.run('INSERT INTO tags (ledger_id, name) VALUES (?,?)', ledgerId, '房贷').lastInsertRowid;

  const mk = (d) => txn.createTransaction(ledgerId, userId, d);
  const t88 = mk({ type: 'expense', amount_cents: 8850, account_id: accId, category_id: catFood, txn_date: '2026-08-05', note: '晚餐' });
  mk({ type: 'expense', amount_cents: 1200, account_id: accId, category_id: catFoodChild, txn_date: '2026-09-01', note: '早饭' });
  mk({ type: 'expense', amount_cents: 3000, account_id: accId, category_id: catTraffic, txn_date: '2026-09-02', note: '地铁' });
  mk({ type: 'income', amount_cents: 50000, account_id: accId, txn_date: '2026-09-03', note: '收入' });
  db.run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)', t88, tagId);

  // 金额按值搜索
  check('搜索 88.5 命中 ¥88.50 交易', txn.listTransactions(ledgerId, { keyword: '88.5' }).rows.some((r) => r.id === t88));
  check('搜索 88.6 不命中该交易', !txn.listTransactions(ledgerId, { keyword: '88.6' }).rows.some((r) => r.id === t88));
  check('非数字关键词仍模糊搜索', txn.listTransactions(ledgerId, { keyword: '晚餐' }).total === 1);

  // 分类多选并集(含子分类)
  const multi = txn.listTransactions(ledgerId, { categoryId: [catFood, catTraffic] });
  check('双分类并集 = 3 笔(含子分类)', multi.total === 3, `total=${multi.total}`);
  check('单分类仍含子分类', txn.listTransactions(ledgerId, { categoryId: catFood }).total === 2);
  check('标签筛选生效', txn.listTransactions(ledgerId, { tagId }).total === 1);

  // trendBreakdown 粒度与聚合
  const byMonth = txn.trendBreakdown(ledgerId, { from: '2026-08-01', to: '2026-09-30' });
  check('跨 2 个月按月粒度', byMonth.grain === 'month' && byMonth.labels.join(',') === '2026-08,2026-09', JSON.stringify(byMonth.labels));
  check('未选分类 → 支出/收入两条', byMonth.series.length === 2 && byMonth.series[0].name === '支出' && byMonth.series[1].name === '收入');
  check('月聚合数值正确(支出 8 月 88.5 / 9 月 42,收入 9 月 500)',
    byMonth.series[0].data.join(',') === '8850,4200' && byMonth.series[1].data.join(',') === '0,50000',
    JSON.stringify(byMonth.series.map((s) => s.data)));
  const byDay = txn.trendBreakdown(ledgerId, { month: '2026-09' });
  check('单月按日粒度(30 个桶)', byDay.grain === 'day' && byDay.labels.length === 30, String(byDay.labels.length));
  const catTrend = txn.trendBreakdown(ledgerId, { from: '2026-08-01', to: '2026-09-30', categoryId: [catFood, catTraffic] });
  check('分类走势每分类一条且带名称', catTrend.series.length === 2 && catTrend.series.every((s) => ['餐饮', '交通'].includes(s.name)),
    JSON.stringify(catTrend.series.map((s) => s.name)));
  check('分类走势零填充对齐(餐饮 8850,1200)', catTrend.series.find((s) => s.name === '餐饮').data.join(',') === '8850,1200');

  /* ------------------------------ B. HTTP 端到端 ------------------------------ */

  const BASE = 'http://127.0.0.1:8099';
  let jar = '';
  async function req(method, p, { form, headers = {}, cookie } = {}) {
    const h = { ...headers };
    h.cookie = cookie || jar;
    if (form) h['content-type'] = 'application/x-www-form-urlencoded';
    let res;
    try {
      res = await fetch(BASE + p, {
        method, headers: h,
        body: form ? new URLSearchParams(form).toString() : undefined,
        redirect: 'manual',
      });
    } catch (e) {
      console.log('\n  (跳过 HTTP 段：8099 隔离实例未启动)\n');
      console.log(`\n${pass} 通过 / ${fail} 失败`);
      process.exit(fail ? 1 : 0);
    }
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length && !cookie) jar = sc.map((c) => c.split(';')[0]).join('; ');
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, text: buf.toString('utf8'), setCookie: sc };
  }
  const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

  console.log('\n=== B. 筛选与走势(HTTP)===\n');

  let r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);

  r = await req('GET', '/transactions?month=2026-09&q=%E5%9C%B0%E9%93%81');
  check('表单保留快捷条件(month hidden 字段)', r.text.includes('name="month" value="2026-09"'));
  check('搜索框回显关键词', r.text.includes('value="地铁"'));
  check('chips/翻页链接输出 q= 而非 keyword=', r.text.includes('q='), '');

  r = await req('GET', '/transactions');
  check('标签筛选下拉存在', r.text.includes('name="tag_id"'));
  check('分类下拉为多选', r.text.includes('name="category_id" multiple'));
  check('走势入口按钮存在', r.text.includes('id="trend-toggle"'));
  check('走势图卡片渲染(SVG + 图例交互属性)', r.text.includes('id="trend-card"') && r.text.includes('class="legend-item"') && r.text.includes('data-series='));
  check('走势图含 tooltip(title)', r.text.includes('<title>'));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
