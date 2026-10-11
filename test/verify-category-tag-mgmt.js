'use strict';
/**
 * 回归:标签/分类管理(改名改色、重名防护、有数据拒删、系统分类解锁)
 * A. lib 层(独立库,路由逻辑核心在 SQL 断言)
 * B. HTTP 端到端(需 8099 隔离实例):页面编辑入口渲染 + 删除拒绝提示
 * 运行:node test/verify-category-tag-mgmt.js
 */
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

const DATA = path.join(__dirname, '..', 'data-verify-ctm');
process.env.DATA_DIR = DATA;
fs.rmSync(DATA, { recursive: true, force: true });

const db = require('../src/db');
const txn = require('../src/lib/txn');

(async () => {
  console.log('\n=== A. 数据层语义(lib)===');

  db.init();
  const run = (...a) => db.run(...a);
  const get = (...a) => db.get(...a);
  const userId = run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)',
    'ctmtest', 'x', '管理测试', db.nowStr()).lastInsertRowid;
  const ledgerId = run('INSERT INTO ledgers (name, owner_id, created_at) VALUES (?,?,?)',
    '管理测试账本', userId, db.nowStr()).lastInsertRowid;
  const accId = run('INSERT INTO accounts (ledger_id, name, type, created_at) VALUES (?,?,?,?)',
    ledgerId, '测试账户', 'debit', db.nowStr()).lastInsertRowid;

  // 系统分类(seed 全局)解锁验证:取一个系统二级与一级
  const sysChild = get("SELECT id, name, parent_id FROM categories WHERE is_system = 1 AND ledger_id IS NULL AND parent_id IS NOT NULL LIMIT 1");
  check('存在系统内置分类可供测试', !!sysChild, JSON.stringify(sysChild));

  // 分类编辑(模拟路由 UPDATE):系统分类改名/图标/颜色
  run('UPDATE categories SET name=?, icon=?, color=? WHERE id = ?', '测试日用品', '🧴', '#00ff00', sysChild.id);
  const after = get('SELECT * FROM categories WHERE id = ?', sysChild.id);
  check('系统分类改名/图标/颜色生效(无 is_system 拦截)', after.name === '测试日用品' && after.icon === '🧴' && after.color === '#00ff00');
  run('UPDATE categories SET name=? WHERE id = ?', sysChild.name, sysChild.id); // 还原

  // 分类删除:有引用(自身)拒绝
  const catA = run("INSERT INTO categories (ledger_id, name, kind, icon) VALUES (?,?, 'expense', 'A')", ledgerId, '甲类').lastInsertRowid;
  const catAChild = run("INSERT INTO categories (ledger_id, name, kind, icon, parent_id) VALUES (?,?, 'expense', 'A', ?)", ledgerId, '甲子', catA).lastInsertRowid;
  const catB = run("INSERT INTO categories (ledger_id, name, kind, icon) VALUES (?,?, 'expense', 'B')", ledgerId, '乙类').lastInsertRowid;
  txn.createTransaction(ledgerId, userId, { type: 'expense', amount_cents: 1000, account_id: accId, category_id: catA, txn_date: '2026-10-01' });

  const usedSelf = get('SELECT COUNT(*) AS c FROM transactions WHERE category_id IN (SELECT ? UNION SELECT id FROM categories WHERE parent_id = ?)', catA, catA).c;
  check('引用计数含子分类(甲类 = 1)', Number(usedSelf) === 1, String(usedSelf));
  check('有引用的分类判定不可删', Number(usedSelf) > 0);
  const usedB = Number(get('SELECT COUNT(*) AS c FROM transactions WHERE category_id IN (SELECT ? UNION SELECT id FROM categories WHERE parent_id = ?)', catB, catB).c || 0);
  check('无引用的分类判定可删', usedB === 0);

  // 模拟「无引用硬删,父连带子」
  run('DELETE FROM categories WHERE id = ?', catB);
  run('DELETE FROM categories WHERE parent_id = ?', catB);
  check('未引用分类已删除', !get('SELECT id FROM categories WHERE id = ?', catB));

  // 标签:改名/改色、重名防护、有关联拒删、无关联可删
  const tag1 = run('INSERT INTO tags (ledger_id, name, color) VALUES (?,?,?)', ledgerId, '房贷', '#ff0000').lastInsertRowid;
  run('INSERT INTO tags (ledger_id, name, color) VALUES (?,?,?)', ledgerId, '医疗', '#00ff00');
  const t1 = txn.createTransaction(ledgerId, userId, { type: 'expense', amount_cents: 2000, account_id: accId, txn_date: '2026-10-02' });
  run('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)', t1, tag1);

  run('UPDATE tags SET name = ?, color = ? WHERE id = ?', '住房', '#00cc00', tag1);
  const tag1After = get('SELECT * FROM tags WHERE id = ?', tag1);
  check('标签改名/改色生效', tag1After.name === '住房' && tag1After.color === '#00cc00');
  check('tags.icon 列已迁移(默认 🔖)', !!db.all('PRAGMA table_info(tags)').find((c) => c.name === 'icon') && tag1After.icon === '🔖');
  run('UPDATE tags SET name = ?, color = ?, icon = ? WHERE id = ?', '住房', '#00cc00', '🏠', tag1);
  check('标签图标更新生效', get('SELECT icon FROM tags WHERE id = ?', tag1).icon === '🏠');
  check('改名后交易关联保持', Number(get('SELECT COUNT(*) AS c FROM transaction_tags WHERE tag_id = ?', tag1).c) === 1);
  const dup = get('SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND id != ?', ledgerId, '医疗', tag1);
  check('重命名撞名可被前置检出', !!dup);
  const tagUsed = Number(get('SELECT COUNT(*) AS c FROM transaction_tags WHERE tag_id = ?', tag1).c || 0);
  check('有关联的标签判定不可删', tagUsed === 1);
  const tagFree = run('INSERT INTO tags (ledger_id, name, color) VALUES (?,?,?)', ledgerId, '空闲', '#0000ff').lastInsertRowid;
  check('无关联的标签判定可删', Number(get('SELECT COUNT(*) AS c FROM transaction_tags WHERE tag_id = ?', tagFree).c) === 0);
  run('DELETE FROM tags WHERE id = ?', tagFree);
  check('无关联标签删除后不存在', !get('SELECT id FROM tags WHERE id = ?', tagFree));

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

  console.log('\n=== B. 管理页(HTTP)===');

  let r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);

  r = await req('GET', '/categories');
  check('分类页含编辑入口(一级+二级)', r.text.includes('cat-edit'));
  check('分类页一级分类有删除按钮', r.text.includes('其子分类会一并处理'));
  check('分类页不再出现「不可修改」拦截文案', !r.text.includes('内置分类不可修改'));

  r = await req('GET', '/tags');
  check('标签页含编辑机制(tag-edit 脚本/入口)', r.text.includes('tag-edit'));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
