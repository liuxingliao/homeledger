'use strict';
/**
 * 回归:报表趋势随筛选范围伸缩 + 模块显隐 + 总览页数据时效
 * A. lib 层(独立库):netWorthTrend ref 起止、monthlyTrend ref、monthsBetween 语义
 * B. HTTP 端到端(需 8099 隔离实例,run-all 负责):趋势标题动态、data-module/浮层渲染、
 *    总览默认上月与显式月份
 * 运行:node test/verify-reports-modules.js
 */
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

const DATA = path.join(__dirname, '..', 'data-verify-rm');
process.env.DATA_DIR = DATA;
fs.rmSync(DATA, { recursive: true, force: true });

const db = require('../src/db');
const txn = require('../src/lib/txn');

(async () => {
  console.log('\n=== A. 趋势伸缩(lib)===');

  db.init();
  const userId = db.run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)',
    'rmtest', 'x', '报表测试', db.nowStr()).lastInsertRowid;
  const ledgerId = db.run('INSERT INTO ledgers (name, owner_id, created_at) VALUES (?,?,?)',
    '报表测试账本', userId, db.nowStr()).lastInsertRowid;
  db.run('INSERT INTO accounts (ledger_id, name, type, initial_cents, created_at) VALUES (?,?,?,?,?)',
    ledgerId, '测试账户', 'debit', 100000, db.nowStr());
  txn.createTransaction(ledgerId, userId, { type: 'expense', amount_cents: 20000, account_id: 1, txn_date: '2025-02-10', note: '支出' });
  txn.createTransaction(ledgerId, userId, { type: 'income', amount_cents: 5000, account_id: 1, txn_date: '2025-03-15', note: '收入' });

  const nw = txn.netWorthTrend(ledgerId, 6, new Date(2025, 5, 1));
  check('netWorthTrend ref 起止(2025-01~2025-06 共 6 个月)',
    nw.length === 6 && nw[0].month === '2025-01' && nw[5].month === '2025-06', JSON.stringify(nw.map((x) => x.month)));
  check('净资产按月末累计(1 月=初始,2 月扣支出,3 月含收入)',
    nw[0].value === 100000 && nw[1].value === 80000 && nw[2].value === 85000 && nw[3].value === 85000,
    JSON.stringify(nw.map((x) => x.value)));
  const mt = txn.monthlyTrend(ledgerId, 12, new Date(2026, 9, 1));
  check('monthlyTrend ref(截至 2026-10 往前 12 个月)',
    mt.length === 12 && mt[0].month === '2025-11' && mt[11].month === '2026-10', JSON.stringify([mt[0].month, mt[11].month]));

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
    return { status: res.status, text: buf.toString('utf8') };
  }
  const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

  console.log('\n=== B. 报表与总览(HTTP)===\n');

  let r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);

  // 记一笔历史交易,让「全部」范围有跨月跨度(空库时区间回退本月)
  r = await req('GET', '/transactions/new');
  const histAcc = (r.text.match(/name="account_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  await req('POST', '/transactions', { form: { _csrf: csrfOf(r.text), type: 'expense', amount: '9.90', account_id: histAcc, txn_date: '2025-02-10', note: '历史交易' } });

  r = await req('GET', '/reports?preset=month');
  check('本月趋势标题为 1 个月', r.text.includes('近 1 个月收支趋势'), '');
  check('报表模块卡片带 data-module(12 个)', (r.text.match(/data-module="/g) || []).length === 12,
    String((r.text.match(/data-module="/g) || []).length));
  check('模块设置入口与浮层存在', r.text.includes('id="mod-toggle"') && r.text.includes('id="mod-panel"') && r.text.includes('data-mod-key'));
  check('恢复默认按钮存在', r.text.includes('id="mod-reset"'));
  check('筛选卡不带 data-module', !/card tight[^"]*"\s*data-module/.test(r.text));

  r = await req('GET', '/reports?preset=all');
  // 隔离库最早交易 2025-02,至今 2026-10 → 21 个月
  check('全部范围趋势标题为多月(21 个月)', r.text.includes('近 21 个月收支趋势'), '');

  // 总览页数据时效
  const now = new Date();
  const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lmLabel = `${lm.getFullYear()}年${lm.getMonth() + 1}月`;
  r = await req('GET', '/');
  check('总览统计卡默认展示上月', r.text.includes(`${lmLabel}支出`) && r.text.includes(`${lmLabel}收入`), lmLabel);
  check('净资产卡保留', r.text.includes('净资产'));
  check('总览趋势标题为 12 个月(截至上月)', r.text.includes(`近 12 个月(截至${lmLabel})`));
  r = await req('GET', '/?month=2026-08');
  check('显式 ?month 覆盖默认', r.text.includes('2026年8月支出'), '');

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
