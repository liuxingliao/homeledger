'use strict';
/**
 * 回归:参与成员(自由名单) / 类型改名 / 报表新维度
 * 独立库 data-verify-pp,进程内直接调 lib 层:
 *   幂等建表、标签改名、参与成员增删改查与替换语义、按人筛选、
 *   tagBreakdown/participantBreakdown、级联删除、CSV 导出含参与成员列
 * 运行:node test/verify-people-participants.js
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data-verify-pp');
process.env.DATA_DIR = DATA;
fs.rmSync(DATA, { recursive: true, force: true });

const db = require('../src/db');
const txn = require('../src/lib/txn');
const importer = require('../src/lib/importers');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
const footer = () => console.log(`\n${pass} 通过 / ${fail} 失败`);

console.log('\n=== A. 建表与类型改名 ===\n');

db.init();
check('ledger_people 表已创建', db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_people'").length === 1);
check('transaction_participants 表已创建', db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_participants'").length === 1);

// 二次 init 幂等(模拟重启)
db.init();
check('重复 init 幂等(无重复建表报错)', db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_people'").length === 1);

const M = db.TXN_TYPE_MAP;
check('lend 显示名 → 代付', M.lend.label === '代付');
check('repay_receive 显示名 → 收债', M.repay_receive.label === '收债');
check('repay_pay 显示名 → 还款', M.repay_pay.label === '还款');
check('adjust 显示名 → 负债变更', M.adjust.label === '负债变更');
check('未改名的类型保持原样', M.expense.label === '支出' && M.borrow.label === '借入' && M.reimburse.label === '报销入账');

console.log('\n=== B. 参与成员与交易 ===\n');

const userId = db.run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)',
  'pptest', 'x', '测试用户', db.nowStr()).lastInsertRowid;
const ledgerId = db.run('INSERT INTO ledgers (name, owner_id, created_at) VALUES (?,?,?)',
  '参与成员测试账本', userId, db.nowStr()).lastInsertRowid;
const accId = db.run('INSERT INTO accounts (ledger_id, name, type, created_at) VALUES (?,?,?,?)',
  ledgerId, '测试账户', 'debit', db.nowStr()).lastInsertRowid;

// 记一笔带参与成员
const t1 = txn.createTransaction(ledgerId, userId, {
  type: 'expense', amount_cents: 5000, account_id: accId, txn_date: '2026-09-01',
  people: '宝宝 刘星燎',
});
check('记一笔带 2 个参与成员',
  db.get('SELECT COUNT(*) AS c FROM transaction_participants WHERE transaction_id = ?', t1).c === 2);
check('名单自动建档 2 人', db.get('SELECT COUNT(*) AS c FROM ledger_people WHERE ledger_id = ?', ledgerId).c === 2);
check('同名成员不重复建档', txn.createTransaction(ledgerId, userId, {
  type: 'expense', amount_cents: 3000, account_id: accId, txn_date: '2026-09-02', people: '宝宝',
}) && db.get('SELECT COUNT(*) AS c FROM ledger_people WHERE ledger_id = ?', ledgerId).c === 2);

// 查询带 participant_names
const row = txn.getTransaction(t1, ledgerId);
check('查询结果含 participant_names', row.participant_names === '宝宝 刘星燎', row.participant_names);

// 列表过滤
const filtered = txn.listTransactions(ledgerId, { personId: db.get('SELECT id FROM ledger_people WHERE name = ?', '宝宝').id });
check('按参与人筛选只返回其交易', filtered.total === 2, `total=${filtered.total}`);
const filtered2 = txn.listTransactions(ledgerId, { personId: db.get('SELECT id FROM ledger_people WHERE name = ?', '刘星燎').id });
check('另一名成员只命中 1 笔', filtered2.total === 1);

// 编辑替换语义
txn.updateTransaction(t1, ledgerId, userId, {
  type: 'expense', amount_cents: 5000, account_id: accId, txn_date: '2026-09-01', people: '宝宝',
});
check('编辑替换参与成员(2 → 1)',
  db.get('SELECT COUNT(*) AS c FROM transaction_participants WHERE transaction_id = ?', t1).c === 1);
const t2 = txn.createTransaction(ledgerId, userId, {
  type: 'expense', amount_cents: 1000, account_id: accId, txn_date: '2026-09-03', people: '',
});
check('空参与成员正常记账(0 条参与关系)',
  db.get('SELECT COUNT(*) AS c FROM transaction_participants WHERE transaction_id = ?', t2).c === 0);

console.log('\n=== C. 报表维度 ===\n');

// t1: 宝宝(5000); t2 无参与人(1000); 另有 3000 宝宝
const pb = txn.participantBreakdown(ledgerId, '2026-09-01', '2026-09-30');
const pbMap = new Map(pb.map((r) => [r.name, r]));
check('按参与人统计含「宝宝」', pbMap.has('宝宝') && Number(pbMap.get('宝宝').expense) === 8000, JSON.stringify([...pbMap].map(([k, v]) => `${k}:${v.expense}`)));
check('被替换出交易的成员不再出现在统计中(刘星燎)', !pbMap.has('刘星燎'));
check('无参与人交易归入「无参与人」行', pbMap.has('无参与人') && Number(pbMap.get('无参与人').expense) === 1000);

const tb = txn.tagBreakdown(ledgerId, '2026-09-01', '2026-09-30', 'expense');
check('按标签统计含「未打标签」行(本月均未打标签)', tb.length === 1 && tb[0].name === '未打标签' && Number(tb[0].total) === 9000, JSON.stringify(tb));

// 打标签后再验证
const tagId = db.run('INSERT INTO tags (ledger_id, name) VALUES (?,?)', ledgerId, '房贷').lastInsertRowid;
db.run('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)', t1, tagId);
const tb2 = txn.tagBreakdown(ledgerId, '2026-09-01', '2026-09-30', 'expense');
const tb2Map = new Map(tb2.map((r) => [r.name, r]));
check('打标签后按标签统计出现「房贷」5000', tb2Map.get('房贷') && Number(tb2Map.get('房贷').total) === 5000, JSON.stringify(tb2.map((r) => `${r.name}:${r.total}`)));
check('其余归入「未打标签」4000', Number(tb2Map.get('未打标签').total) === 4000);

console.log('\n=== D. 名单管理与级联删除 ===\n');

// 重命名保持归属
const baoId = db.get('SELECT id FROM ledger_people WHERE name = ?', '宝宝').id;
db.run('UPDATE ledger_people SET name = ? WHERE id = ?', '宝宝(小)', baoId);
check('重命名后参与关系保持', db.get('SELECT COUNT(*) AS c FROM transaction_participants WHERE person_id = ?', baoId).c === 2);

// 级联删除
db.run('DELETE FROM transaction_participants WHERE person_id = ?', baoId);
db.run('DELETE FROM ledger_people WHERE id = ?', baoId);
check('删除人员后参与关系一并移除', db.get('SELECT COUNT(*) AS c FROM transaction_participants WHERE person_id = ?', baoId).c === 0);
check('交易本身不受影响', db.get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', ledgerId).c === 3);

console.log('\n=== E. CSV 导出含参与成员列 ===\n');

const { EXPORT_HEADER, exportRows } = importer;
check('导出表头含「参与成员」列', EXPORT_HEADER.includes('参与成员'));
const exportRow = exportRows(ledgerId, [txn.getTransaction(t2, ledgerId)])[0];
check('导出行参与成员列为空串占位', exportRow[EXPORT_HEADER.indexOf('参与成员')] === '');

footer();
process.exit(fail ? 1 : 0);
