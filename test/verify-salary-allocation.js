'use strict';
/**
 * 回归：工资收入按比例分配 / 账户分配比例配置 / 标签选择
 *
 * 两段：
 *  A. lib 层直调（独立库 data-verify-salary）：computeAllocation 整数分配规则、
 *     createSalaryAllocation 落账/校验/余额/标签参与成员共享
 *  B. HTTP 端到端（需先在 8099 起隔离实例，run-all.js 已负责）：
 *     账户比例配置（创建/编辑/越界钳制/非 other 无配置项）、工资 POST 分支、
 *     表单渲染（工资入口、标签 datalist）
 *
 * 运行：node test/verify-salary-allocation.js（B 段需 PORT=8099 隔离实例）
 */
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

/* --------------------------- A. lib 层（独立库） --------------------------- */

const DATA = path.join(__dirname, '..', 'data-verify-salary');
process.env.DATA_DIR = DATA;
fs.rmSync(DATA, { recursive: true, force: true });

const db = require('../src/db');
const txn = require('../src/lib/txn');

(async () => {
  console.log('\n=== A. computeAllocation 分配规则（lib）===\n');

  db.init();

  check('整除分配 10000 分 × 30/30/40', txn.computeAllocation(10000, [
    { id: 1, alloc_ratio: 30 }, { id: 2, alloc_ratio: 30 }, { id: 3, alloc_ratio: 40 },
  ]).map((p) => p.cents).join(',') === '3000,3000,4000');

  const r1 = txn.computeAllocation(10, [{ id: 1, alloc_ratio: 33 }, { id: 2, alloc_ratio: 33 }, { id: 3, alloc_ratio: 34 }]);
  check('非整除余数补给最大比例户(10 分 × 33/33/34 → 3/3/4)',
    r1.map((p) => p.cents).join(',') === '3,3,4' && r1.reduce((s, p) => s + p.cents, 0) === 10, JSON.stringify(r1));

  const rTie = txn.computeAllocation(3, [{ id: 1, alloc_ratio: 50 }, { id: 2, alloc_ratio: 50 }]);
  check('并列比例余数按 id 升序补(3 分 × 50/50 → 2/1)',
    rTie.map((p) => p.cents).join(',') === '2,1' && rTie.reduce((s, p) => s + p.cents, 0) === 3, JSON.stringify(rTie));

  const r3 = txn.computeAllocation(500, [{ id: 1, alloc_ratio: 0 }, { id: 2, alloc_ratio: 100 }]);
  check('ratio=0 的账户不参与分配', r3.length === 1 && r3[0].account_id === 2 && r3[0].cents === 500, JSON.stringify(r3));

  const r4 = txn.computeAllocation(100, [{ id: 1, alloc_ratio: 200 }, { id: 2, alloc_ratio: -5 }]);
  check('越界比例被钳制到 0~100', r4.every((p) => p.ratio >= 0 && p.ratio <= 100), JSON.stringify(r4));

  console.log('\n=== B. createSalaryAllocation 落账（lib）===\n');

  const userId = db.run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)',
    'saltest', 'x', '工资测试', db.nowStr()).lastInsertRowid;
  const ledgerId = db.run('INSERT INTO ledgers (name, owner_id, created_at) VALUES (?,?,?)',
    '工资测试账本', userId, db.nowStr()).lastInsertRowid;
  const insAcc = (name, type, ratio) => db.run(
    'INSERT INTO accounts (ledger_id, name, type, alloc_ratio, created_at) VALUES (?,?,?,?,?)',
    ledgerId, name, type, ratio, db.nowStr()).lastInsertRowid;
  const accA = insAcc('生活基金', 'other', 30);
  const accB = insAcc('教育金', 'other', 70);
  insAcc('工资卡', 'debit', 0);

  const r = txn.createSalaryAllocation(ledgerId, userId, {
    totalCents: 10000, txn_date: '2026-10-11', note: '十月工资', tags: '工资', people: '宝宝',
  });
  check('生成 2 笔收入交易', r.ids.length === 2);
  check('每笔金额精确 3000/7000 分', r.parts.map((p) => p.cents).join(',') === '3000,7000', JSON.stringify(r.parts));
  const rows = db.all(`SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL`, ledgerId);
  check('落账类型均为 income 且挂在对应账户', rows.length === 2 &&
    rows.some((t) => t.type === 'income' && Number(t.account_id) === accA && t.amount_cents === 3000) &&
    rows.some((t) => t.type === 'income' && Number(t.account_id) === accB && t.amount_cents === 7000));
  check('两笔共享同一 group_id', rows[0].group_id && rows[0].group_id === rows[1].group_id);
  const bal = new Map(db.all('SELECT id, balance_cents FROM accounts WHERE ledger_id = ?', ledgerId).map((a) => [Number(a.id), Number(a.balance_cents)]));
  check('余额随交易重算(3000/7000)', bal.get(Number(accA)) === 3000 && bal.get(Number(accB)) === 7000,
    `生活基金=${bal.get(Number(accA))} 教育金=${bal.get(Number(accB))}`);
  check('标签只建一个且两笔共用', db.get('SELECT COUNT(*) AS c FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, '工资').c === 1
    && db.get('SELECT COUNT(*) AS c FROM transaction_tags').c === 2);
  check('参与成员两笔共享', db.get('SELECT COUNT(*) AS c FROM transaction_participants').c === 2);

  // 已有标签再选择不产生重复（标签选择规格场景）
  txn.createTransaction(ledgerId, userId, { type: 'expense', amount_cents: 100, account_id: accA, txn_date: '2026-10-11', tags: '工资 新标签' });
  check('已有标签「工资」不重复建档', db.get('SELECT COUNT(*) AS c FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, '工资').c === 1);
  check('新标签照常创建', db.get('SELECT COUNT(*) AS c FROM tags WHERE ledger_id = ? AND name = ?', ledgerId, '新标签').c === 1);

  let threw = '';
  const before = Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', ledgerId).c);
  insAcc('备用金', 'other', 0);
  const r5 = txn.createSalaryAllocation(ledgerId, userId, { totalCents: 1000, txn_date: '2026-10-11' });
  check('ratio=0 账户不破坏总和校验(30+70+0=100 仍可分配，生成 2 笔)',
    r5.ids.length === 2 && Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', ledgerId).c) === before + 2);
  // 精确清理第二笔分配，恢复到断言基数
  db.run(`DELETE FROM transactions WHERE id IN (${r5.ids.map(() => '?').join(',')})`, ...r5.ids);
  db.run('DELETE FROM transaction_tags WHERE transaction_id NOT IN (SELECT id FROM transactions)');
  db.run('DELETE FROM transaction_participants WHERE transaction_id NOT IN (SELECT id FROM transactions)');

  db.run('UPDATE accounts SET alloc_ratio = 60 WHERE id = ?', accB);
  threw = '';
  try { txn.createSalaryAllocation(ledgerId, userId, { totalCents: 1000, txn_date: '2026-10-11' }); }
  catch (e) { threw = e.message; }
  check('比例总和≠100% 阻止并提示(90%)', threw.includes('90%'), threw);
  check('失败时不产生任何交易', Number(db.get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', ledgerId).c) === before);

  db.run('UPDATE accounts SET alloc_ratio = 70 WHERE id = ?', accB);
  threw = '';
  try { txn.createSalaryAllocation(ledgerId, userId, { totalCents: 0, txn_date: '2026-10-11' }); }
  catch (e) { threw = e.message; }
  check('金额为 0 阻止', threw.includes('金额'), threw);

  const emptyLedger = db.run('INSERT INTO ledgers (name, owner_id, created_at) VALUES (?,?,?)',
    '空账本', userId, db.nowStr()).lastInsertRowid;
  threw = '';
  try { txn.createSalaryAllocation(emptyLedger, userId, { totalCents: 1000, txn_date: '2026-10-11' }); }
  catch (e) { threw = e.message; }
  check('无「其他」账户时阻止并提示', threw.includes('其他'), threw);

  /* ------------------------------ C. HTTP 端到端 ------------------------------ */

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

  console.log('\n=== C. 工资分配 HTTP 端到端 ===\n');

  let r2 = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r2.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);

  r2 = await req('GET', '/transactions/new');
  check('记一笔页渲染工资收入入口', r2.text.includes('data-type="salary"') && r2.text.includes('工资收入'));
  check('记一笔页渲染工资分配区块', r2.text.includes('id="salary-alloc"'));
  check('记一笔页渲染标签 datalist', r2.text.includes('id="tags-datalist"'));
  const csrf = csrfOf(r2.text);

  await req('POST', '/accounts', { form: { _csrf: csrf, name: '生活基金', type: 'other', alloc_ratio: '30', initial_balance: '0.00' } });
  await req('POST', '/accounts', { form: { _csrf: csrf, name: '教育金', type: 'other', alloc_ratio: '60', initial_balance: '0.00' } });
  await req('POST', '/accounts', { form: { _csrf: csrf, name: '工资卡', type: 'debit', initial_balance: '0.00' } });
  r2 = await req('GET', '/accounts');
  check('创建「其他」账户并保存比例 30/60', r2.text.includes('工资分配比例 30%') && r2.text.includes('工资分配比例 60%'));
  // 2 个编辑表单（仅 other）+ 1 个新建表单（隐藏，类型联动显示）
  check('非「其他」账户不出现比例配置项', (r2.text.match(/name="alloc_ratio"/g) || []).length === 3,
    String((r2.text.match(/name="alloc_ratio"/g) || []).length));

  // 找到账户 id（名称节点带图标前缀；编辑表单 action="/accounts/<id>"，archive/delete/adjust 均带后缀不会误匹配）
  function accIdByName(html, name) {
    const i = html.indexOf(name);
    if (i < 0) return null;
    const m = html.slice(i).match(/action="\/accounts\/(\d+)">/);
    return m ? Number(m[1]) : null;
  }

  r2 = await req('POST', '/transactions', {
    form: { _csrf: csrf, type: 'salary', amount: '1000.00', txn_date: '2026-10-11', note: '十月工资', tags: '工资', people: '宝宝' },
  });
  check('比例总和 90% 时保存被阻止', r2.status === 400 && r2.text.includes('90%'), `HTTP ${r2.status}`);

  r2 = await req('GET', '/accounts');
  const accEdu = accIdByName(r2.text, '教育金');
  check('能从页面定位账户 id', !!accEdu, String(accEdu));
  await req('POST', `/accounts/${accEdu}`, { form: { _csrf: csrf, name: '教育金', type: 'other', alloc_ratio: '250', initial_balance: '0.00' } });
  r2 = await req('GET', '/accounts');
  check('编辑比例越界钳制到 100', r2.text.includes('工资分配比例 100%'));

  await req('POST', `/accounts/${accEdu}`, { form: { _csrf: csrf, name: '教育金', type: 'other', alloc_ratio: '70', initial_balance: '0.00' } });
  r2 = await req('GET', '/accounts');
  check('编辑比例保存为 70', r2.text.includes('工资分配比例 70%'));

  r2 = await req('POST', '/transactions', {
    form: { _csrf: csrf, type: 'salary', amount: '1000.00', txn_date: '2026-10-11', note: '十月工资', tags: '工资', people: '宝宝' },
  });
  check('比例总和 100% 保存成功(302)', r2.status === 302, `HTTP ${r2.status}`);

  r2 = await req('GET', '/accounts');
  check('生活基金余额 +300', r2.text.includes('¥300.00'), '');
  check('教育金余额 +700', r2.text.includes('¥700.00'));

  r2 = await req('GET', '/transactions');
  check('交易列表出现 300/700 两笔收入', r2.text.includes('300.00') && r2.text.includes('700.00'));
  check('两笔收入带标签「工资」', r2.text.includes('工资'));

  // 非 other 账户提交比例 → 路由强制 0，页面配置项数量不变（2 编辑 + 1 新建）
  const accCard = accIdByName(r2.text, '工资卡');
  await req('POST', `/accounts/${accCard}`, { form: { _csrf: csrf, name: '工资卡', type: 'debit', alloc_ratio: '80', initial_balance: '0.00' } });
  r2 = await req('GET', '/accounts');
  check('对 debit 账户提交比例不生效(仍 3 个配置项)', (r2.text.match(/name="alloc_ratio"/g) || []).length === 3,
    String((r2.text.match(/name="alloc_ratio"/g) || []).length));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
