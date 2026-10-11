'use strict';
/**
 * 回归:随手记账本完整导入(preview 解析 → importRecords 入库)
 * 独立库 data-verify-ssj,直接调 lib 层,断言 910 条零丢失、二次导入去重、
 * 分类树/标签/参与成员/负债符号/指纹判重等
 * 运行:node test/verify-ssj-import.js
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data-verify-ssj');
process.env.DATA_DIR = DATA;
fs.rmSync(DATA, { recursive: true, force: true });

const db = require('../src/db');
const importer = require('../src/lib/importers');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
const footer = () => console.log(`\n${pass} 通过 / ${fail} 失败`);

console.log('\n=== A. 随手记完整导入 ===\n');

db.init();

// 建一个测试账本与用户
const userId = db.run('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)',
  'ssjtest', 'x', '测试用户', db.nowStr()).lastInsertRowid;
const ledgerId = db.run('INSERT INTO ledgers (name, owner_id, created_at) VALUES (?,?,?)',
  '随手记测试账本', userId, db.nowStr()).lastInsertRowid;

const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'suishouji-sample.xlsx'));
check('detectFormat 识别为随手记候选', importer.detectFormat(buf) === 'suishouji-candidate');

const parsed = importer.parseSuishouji(buf);
check('解析 910 条 / 0 失败', parsed.records.length === 910 && parsed.failedRows.length === 0);

// 首次导入
const r1 = importer.importRecords({
  ledgerId, userId,
  records: parsed.records, neutralRecords: [],
  source: parsed.source, fileName: '随手记公共账户.xlsx',
  failedRows: parsed.failedRows, sheetStats: parsed.sheetStats,
});
check('首次导入 910 条全部成功', r1.imported === 910, `imported=${r1.imported} failed=${r1.failed}`);
check('0 条跳过(首次导入无指纹冲突)', r1.skipped === 0);
check('无失败明细', r1.failedRows.length === 0);

const cnt = (sql, ...p) => db.get(sql, ...p).c;
check('transactions 表 910 行', cnt('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', ledgerId) === 910);

// 类型分布
const typeDist = {};
for (const row of db.all('SELECT type, COUNT(*) AS c FROM transactions WHERE ledger_id = ? GROUP BY type', ledgerId)) typeDist[row.type] = row.c;
check('类型分布与源一致', typeDist.expense === 416 && typeDist.income === 475 && typeDist.adjust === 12
  && typeDist.lend === 2 && typeDist.borrow === 1 && typeDist.transfer === 3 && typeDist.repay_receive === 1, JSON.stringify(typeDist));

// 账户自动创建与类型推断
const accs = {};
for (const a of db.all('SELECT name, type FROM accounts WHERE ledger_id = ?', ledgerId)) accs[a.name] = a.type;
check('11 个账户全部自动创建', Object.keys(accs).length === 11, JSON.stringify(Object.keys(accs)));
check('「欠工商银行」→ payable', accs['欠工商银行'] === 'payable');
check('「欠润辛妈」→ payable', accs['欠润辛妈'] === 'payable');
check('「刘妈欠款」→ receivable', accs['刘妈欠款'] === 'receivable');
check('「刘志杰欠款」→ receivable', accs['刘志杰欠款'] === 'receivable');
check('「网商银行定期」→ investment', accs['网商银行定期'] === 'investment');
check('「生活基金」为普通资金账户', ['other', 'debit'].includes(accs['生活基金']));

// 负债变更方向:欠工商银行余额 = 初始0 + (-41000000) + Σ(+还款) → 负值(欠款)
const bank = db.get('SELECT balance_cents FROM accounts WHERE name = ? AND ledger_id = ?', '欠工商银行', ledgerId);
check('欠工商银行余额为负(410000 债务入账,还款回升)', Number(bank.balance_cents) < 0, String(bank.balance_cents));
const expectBank = -41000000 + 129422 + 64453 + 128392 + 10032680 + 86420 + 86190 + 171694 + 169757 + 83864 + 83643 + 2283600;
check('欠工商银行余额精确匹配 Σ负债变更', Number(bank.balance_cents) === expectBank, `expect=${expectBank}`);

// 分类树
const catPair = db.get(
  `SELECT c.id FROM categories c JOIN categories p ON p.id = c.parent_id
   WHERE c.ledger_id = ? AND p.name = '日常开支' AND c.name = '生活用品'`, ledgerId);
check('两级分类树「日常开支/生活用品」已建', !!catPair);
const incomeCat = db.get("SELECT id FROM categories WHERE ledger_id = ? AND kind = 'income' AND name = '宝宝收入' AND parent_id IS NULL", ledgerId);
check('收入一级分类「宝宝收入」(跳过常量父级)', !!incomeCat);

// 标签(项目)
const tagRow = db.get('SELECT t.id FROM tags t WHERE t.ledger_id = ? AND t.name = ?', ledgerId, '房贷');
check('标签「房贷」已创建', !!tagRow);
if (tagRow) {
  const tagged = cnt('SELECT COUNT(*) AS c FROM transaction_tags WHERE tag_id = ?', tagRow.id);
  check('标签「房贷」已关联交易', tagged > 0, `${tagged} 笔`);
}

// 参与成员
const peopleRows = db.all('SELECT name FROM ledger_people WHERE ledger_id = ?', ledgerId);
const peopleNames = peopleRows.map((p) => p.name).sort();
check('参与成员名单自动建档(宝宝/刘星燎)', peopleNames.includes('宝宝') && peopleNames.includes('刘星燎'), peopleNames.join(','));
check('名单只有 2 人(成员列取值完备)', peopleNames.length === 2, String(peopleNames.length));
const partCnt = cnt('SELECT COUNT(*) AS c FROM transaction_participants tp JOIN ledger_people lp ON lp.id = tp.person_id WHERE lp.ledger_id = ?', ledgerId);
check('参与关系 897 条(910 - 13 无成员行)', partCnt === 897, String(partCnt));

// 溯源字段
const sampleTxn = db.get("SELECT ai_json, note, txn_date FROM transactions WHERE ledger_id = ? AND ai_json LIKE '%suishouji%' LIMIT 1", ledgerId);
const meta = JSON.parse(sampleTxn.ai_json);
check('ai_json 保留 sheet/row_no/datetime/booker/raw', !!(meta.sheet && meta.row_no && meta.datetime && meta.booker && Array.isArray(meta.raw)));
check('ai_json datetime 精确到秒', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(meta.datetime));

// 借还台账(代付/借入 → syncDebts)
const debtRows = db.all('SELECT counterparty, direction FROM debts WHERE ledger_id = ?', ledgerId);
check('借还台账含刘妈/刘志杰(应收)与润辛妈(应付)',
  debtRows.some((d) => d.counterparty === '刘妈' && d.direction === 'receivable')
  && debtRows.some((d) => d.counterparty === '刘志杰' && d.direction === 'receivable')
  && debtRows.some((d) => d.counterparty === '润辛妈' && d.direction === 'payable'), JSON.stringify(debtRows));

// 借贷双录:应收/应付账户余额 = Σ对手方效应(代付+,收债−;借入−,还款+)
const balOf = (name) => Number(db.get('SELECT balance_cents FROM accounts WHERE ledger_id = ? AND name = ?', ledgerId, name).balance_cents);
check('「刘妈欠款」余额 = 代付 100000.00(应收)', balOf('刘妈欠款') === 10000000, String(balOf('刘妈欠款')));
check('「刘志杰欠款」余额 = 代付 10000 − 收债 10000 = 0', balOf('刘志杰欠款') === 0, String(balOf('刘志杰欠款')));
check('「欠润辛妈」余额 = 借入 50000.00(应付,负值)', balOf('欠润辛妈') === -5000000, String(balOf('欠润辛妈')));
check('「欠工商银行」不受双录影响(仅负债变更)', balOf('欠工商银行') === expectBank, String(balOf('欠工商银行')));

console.log('\n=== B. 重复导入与指纹判重 ===\n');

// 二次导入同一文件:全部按「日期|金额|源时间」指纹跳过
const parsed2 = importer.parseSuishouji(buf);
const r2 = importer.importRecords({
  ledgerId, userId, records: parsed2.records, neutralRecords: [],
  source: parsed2.source, fileName: '随手记公共账户.xlsx',
});
check('二次导入全部跳过', r2.imported === 0 && r2.skipped === 910, `imported=${r2.imported} skipped=${r2.skipped}`);
check('二次导入交易数不变', cnt('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', ledgerId) === 910);
check('名单人数不变', cnt('SELECT COUNT(*) AS c FROM ledger_people WHERE ledger_id = ?', ledgerId) === 2);

// 同日同金额的两笔不被误杀(源时间不同)
const dupProbe = db.all(
  `SELECT txn_date, amount_base_cents, COUNT(*) AS c FROM transactions
   WHERE ledger_id = ? AND type = 'expense' GROUP BY txn_date, amount_base_cents HAVING c > 1 LIMIT 1`, ledgerId);
check('存在同日同金额的多笔支出(证明未被误判重复)', dupProbe.length > 0, JSON.stringify(dupProbe));

console.log('\n=== C. CSV 导入回归(旧路径不受影响) ===\n');

const csv = '﻿交易时间,交易分类,交易对方,收/支,金额(元),收/付款方式,当前状态\n' +
  '2026-01-05 12:00:00,交通-地铁,地铁公司,支出,12.50,支付宝余额,交易成功\n' +
  '2026-01-06 09:00:00,工资,某某公司,收入,8888.00,银行卡,已到账\n' +
  '2026-01-07 10:00:00,不计收支,零钱通,不计收支,100.00,零钱,交易成功\n';
const csvParsed = importer.parseBill(Buffer.from(csv, 'utf8'));
check('CSV 解析:2 条正式 + 1 条不计收支', csvParsed.records.length === 2 && csvParsed.neutralRecords.length === 1);
const r3 = importer.importRecords({
  ledgerId, userId, records: csvParsed.records, neutralRecords: csvParsed.neutralRecords,
  source: 'alipay', fileName: 'alipay.csv',
});
check('CSV 导入 2 条成功', r3.imported === 2, JSON.stringify({ imported: r3.imported, failed: r3.failed }));
check('CSV 路径不产生参与成员(people 为空)', cnt('SELECT COUNT(*) AS c FROM transaction_participants tp JOIN ledger_people lp ON lp.id = tp.person_id WHERE lp.ledger_id = ?', ledgerId) === 897);
const csvTxn = db.get("SELECT type, amount_cents FROM transactions WHERE ledger_id = ? AND note LIKE '%地铁%'", ledgerId);
check('CSV 记录类型/金额正确', csvTxn && csvTxn.type === 'expense' && csvTxn.amount_cents === 1250);

console.log('\n=== D. 借贷双录与核销联动 ===\n');

const txn = require('../src/lib/txn');
const accAsset = db.run('INSERT INTO accounts (ledger_id, name, type, created_at) VALUES (?,?,?,?)',
  ledgerId, '双录测试资产', 'debit', db.nowStr()).lastInsertRowid;
const accRecv = db.run('INSERT INTO accounts (ledger_id, name, type, created_at) VALUES (?,?,?,?)',
  ledgerId, '双录测试应收', 'receivable', db.nowStr()).lastInsertRowid;
const bal2 = () => ({
  a: Number(db.get('SELECT balance_cents FROM accounts WHERE id = ?', accAsset).balance_cents),
  r: Number(db.get('SELECT balance_cents FROM accounts WHERE id = ?', accRecv).balance_cents),
});

txn.createTransaction(ledgerId, userId, {
  type: 'lend', amount_cents: 50000, account_id: accAsset, to_account_id: accRecv,
  txn_date: '2026-10-11', merchant: '双录测试人',
});
let b = bal2();
check('代付双录:资产 −50 / 应收 +50(净资产不变)', b.a === -50000 && b.r === 50000, JSON.stringify(b));

txn.createTransaction(ledgerId, userId, {
  type: 'repay_receive', amount_cents: 20000, account_id: accAsset, to_account_id: accRecv,
  txn_date: '2026-10-11', merchant: '双录测试人',
});
b = bal2();
check('收债核销:资产 +20 / 应收 −20(余额 30)', b.a === -30000 && b.r === 30000, JSON.stringify(b));

// 台账核销路由的对手方定位 SQL:按 merchant 找到录入时的应收/应付账户
const cp = db.get(
  `SELECT t.to_account_id AS id FROM transactions t JOIN accounts a ON a.id = t.to_account_id
   WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.merchant = ? AND a.type IN ('receivable','payable')
   LIMIT 1`, ledgerId, '双录测试人');
check('台账核销能定位对手方账户', cp && Number(cp.id) === Number(accRecv), JSON.stringify(cp));

footer();
process.exit(fail ? 1 : 0);
