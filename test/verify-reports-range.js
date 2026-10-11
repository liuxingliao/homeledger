'use strict';
/**
 * 回归:报表时间范围(缺陷修复——「全部」曾按 URL ledger_id=0 查询导致统计为空)
 * 需先在 8099 起隔离实例(run-all.js 已负责)。覆盖:
 *   历史交易(本月之外)在 preset=all 下可见、本月视图不含、preset=year 行为不变
 * 运行:node test/verify-reports-range.js
 */
const BASE = 'http://127.0.0.1:8099';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

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
    console.log('\n  (跳过：8099 隔离实例未启动)\n');
    console.log(`\n${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length && !cookie) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), setCookie: sc };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== 报表时间范围(HTTP 端到端)===\n');

  let r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);

  r = await req('GET', '/transactions/new');
  const csrf = csrfOf(r.text);

  // 记一笔历史交易(上一个月,避开本月边界)与一笔本月交易,金额取独特值便于文本断言
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const histDate = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-15`;
  const histAmount = '123.45';
  const thisAmount = '678.90';
  const accId = (r.text.match(/name="account_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  check('表单含账户选项', !!accId, String(accId));

  await req('POST', '/transactions', { form: { _csrf: csrf, type: 'expense', amount: histAmount, account_id: accId, txn_date: histDate, note: '历史交易' } });
  await req('POST', '/transactions', { form: { _csrf: csrf, type: 'expense', amount: thisAmount, account_id: accId, txn_date: '', note: '本月交易' } });
  // 一笔本月收入,避免「净资产 = −支出合计」与断言值巧合重合(净资产变为 1000.00 − 802.35)
  await req('POST', '/transactions', { form: { _csrf: csrf, type: 'income', amount: '1000.00', account_id: accId, txn_date: '', note: '本月收入' } });

  // 断言用区间支出合计(两笔相加 802.35,不与 12 个月趋势图的 per-month title 冲突):
  // 「全部」合计必须包含历史交易(修复前起点回退本月,合计只有 678.90)
  const total = '802.35';
  r = await req('GET', '/reports?preset=all');
  check('「全部」视图支出合计含历史交易(802.35)', r.text.includes(total), `HTTP ${r.status}`);
  check('「全部」视图标签为「全部时间」', r.text.includes('全部时间'));

  // 本月视图:合计只有本月金额
  r = await req('GET', '/reports');
  check('本月视图合计不含历史交易(仅 678.90)', !r.text.includes(total) && r.text.includes(thisAmount));

  // 本年视图:历史交易在本年内也应可见(既有语义回归)
  r = await req('GET', '/reports?preset=year');
  check('「本年」视图含历史交易(合计 802.35)', r.text.includes(total));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
