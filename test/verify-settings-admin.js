'use strict';
/**
 * 回归：系统管理并入设置页（GET /settings#admin + /admin 重定向）
 *
 * 需先在 8099 起隔离实例：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify-about node server.js
 * 覆盖：/admin 重定向、设置页含系统管理区块（标签页/用户管理/审计日志/后台任务）、
 *       侧栏不再有独立 /admin 入口、后台任务手动触发回跳
 *
 * 运行：node test/verify-settings-admin.js
 */
const BASE = 'http://127.0.0.1:8099';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

let jar = '';
async function req(method, p, { form, json, headers = {}, cookie } = {}) {
  const h = { ...headers };
  h.cookie = cookie || jar;
  let body;
  if (form) { h['content-type'] = h['content-type'] || 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  else if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(BASE + p, {
    method, headers: h, body,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length && !cookie) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), location: res.headers.get('location'), setCookie: sc };
}

const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== 系统管理并入设置（HTTP 端到端）===\n');

  /* --- 登录 --- */
  let r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  const cookie = loginRes.setCookie.map((c) => c.split(';')[0]).join('; ');

  /* --- /admin 老链接重定向 --- */
  r = await req('GET', '/admin', { cookie });
  check('/admin 重定向到 /settings#admin', r.status === 302 && r.location === '/settings#admin', `${r.status} ${r.location}`);

  /* --- 侧栏：独立入口已移除 --- */
  r = await req('GET', '/', { cookie });
  check('侧栏不再有独立「系统管理」入口', !r.text.includes('href="/admin"'));
  check('侧栏仍有「设置」入口', r.text.includes('href="/settings"'));

  /* --- 设置页：系统管理区块挂载 --- */
  r = await req('GET', '/settings', { cookie });
  check('设置页可访问', r.status === 200, `HTTP ${r.status}`);
  check('标签页含「系统管理」', r.text.includes('href="#admin"'));
  check('系统管理区块挂载（id=admin）', r.text.includes('id="admin"'));
  check('用户管理表格渲染', r.text.includes('用户管理') && r.text.includes('重置密码') && r.text.includes('/admin/users/'));
  check('后台任务卡片渲染', r.text.includes('后台任务') && r.text.includes('/admin/run-scheduler'));
  check('审计日志卡片渲染', r.text.includes('操作审计日志'));
  check('统计卡渲染（用户/账本/记账总数）', r.text.includes('记账总数') && r.text.includes('账单截图'));
  check('运行信息含管理员专属项（内存/PID/备份）', r.text.includes('内存占用') && r.text.includes('/backup/db'));
  check('锚点高亮脚本通用化（按 hash 匹配）', r.text.includes("x.getAttribute('href') === location.hash") || r.text.includes("a.getAttribute('href') === '#' + name"));
  check('标签切换：6 个区块带 data-tab', (r.text.match(/data-tab="/g) || []).length === 6, String((r.text.match(/data-tab="/g) || []).length));
  check('标签切换：点击只显示当前区块', r.text.includes("el.getAttribute('data-tab') !== name"));
  check('标签切换：默认显示账号安全', r.text.includes("showTab((location.hash || '#account').slice(1)"));

  /* --- 后台任务手动触发回跳 --- */
  const csrf = csrfOf(r.text);
  r = await req('POST', '/admin/run-scheduler', { cookie, form: { _csrf: csrf } });
  check('手动执行后台任务后回跳设置页', r.status === 302 && r.location === '/settings#admin', `${r.status} ${r.location}`);

  /* --- 顶栏用户菜单 --- */
  r = await req('GET', '/', { cookie });
  check('顶栏有用户菜单（头像按钮 + 下拉）', r.text.includes('id="userMenu"') && r.text.includes('id="userMenuDrop"'));
  check('下拉含个人资料/设置/退出登录', r.text.includes('个人资料与头像') && r.text.includes('action="/logout"'));
  check('侧栏底部不再有 user-chip', !r.text.includes('class="user-chip"'));
  check('侧栏保留主题切换', r.text.includes('/theme/'));

  /* --- 用户名修改 --- */
  r = await req('GET', '/settings', { cookie });
  let csrf2 = csrfOf(r.text);
  // 非法格式被拒
  r = await req('POST', '/settings/profile', { cookie, form: { _csrf: csrf2, display_name: '管理员', username: 'a b!', email: '' } });
  check('非法用户名被拒并回跳', r.status === 302, `HTTP ${r.status}`);
  r = await req('GET', '/settings', { cookie });
  check('拒绝提示出现', r.text.includes('2-24 位字母、数字'));
  // 合法修改成功
  r = await req('GET', '/settings', { cookie });
  csrf2 = csrfOf(r.text);
  r = await req('POST', '/settings/profile', { cookie, form: { _csrf: csrf2, display_name: '管理员', username: 'admin2', email: '' } });
  check('合法用户名修改成功', r.status === 302, `HTTP ${r.status}`);
  r = await req('GET', '/settings', { cookie });
  check('新用户名已生效', r.text.includes('name="username" value="admin2"'));
  // 改回去（后续用例按 admin 会话继续，登录态不受影响）
  csrf2 = csrfOf(r.text);
  r = await req('POST', '/settings/profile', { cookie, form: { _csrf: csrf2, display_name: '管理员', username: 'admin', email: '' } });
  check('用户名改回 admin', r.status === 302, `HTTP ${r.status}`);

  /* --- 头像上传 / 清除 --- */
  // 1x1 红色 PNG（合法魔数）
  const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const postJson = async (p, obj) => req('POST', p, { cookie, headers: { 'x-csrf-token': csrf2 }, json: obj });
  // 空载荷被拒
  r = await postJson('/settings/avatar', {});
  check('空载荷返回 400', r.status === 400, `HTTP ${r.status}`);
  // 非法内容被拒
  r = await postJson('/settings/avatar', { dataUrl: 'data:image/png;base64,' + Buffer.from('not-an-image-at-all-just-text!!').toString('base64') });
  check('非图片内容被拒', r.status === 400, `HTTP ${r.status}`);
  // 合法 PNG 上传
  r = await postJson('/settings/avatar', { dataUrl: 'data:image/png;base64,' + PNG_1PX.toString('base64') });
  check('合法 PNG 上传成功', r.status === 200 && r.text.includes('"ok":true'), r.text.slice(0, 80));
  r = await req('GET', '/settings', { cookie });
  check('设置页显示头像图与恢复按钮', r.text.includes('/uploads/avatars/user-1.png') && r.text.includes('id="avatarClear"'));
  r = await req('GET', '/uploads/avatars/user-1.png', { cookie: '' });
  check('头像文件可通过 /uploads 访问', r.status === 200, `HTTP ${r.status}`);
  // 清除
  r = await postJson('/settings/avatar/clear', {});
  check('清除头像成功', r.status === 200 && r.text.includes('"ok":true'), r.text.slice(0, 80));
  r = await req('GET', '/settings', { cookie });
  check('清除后回退首字母色块', !r.text.includes('/uploads/avatars/') && r.text.includes('id="avatarPick"'));
  r = await req('GET', '/uploads/avatars/user-1.png', { cookie: '' });
  check('头像文件已删除', r.status === 404, `HTTP ${r.status}`);
  // 顶栏点击头像换头像（全站通用入口）
  r = await req('GET', '/', { cookie });
  check('顶栏头像带点击换头像标识', r.text.includes('id="userMenuAvatar"') && r.text.includes('avatar-click'), '');
  check('顶栏有通用头像文件选择框', r.text.includes('id="userAvatarFile"'), '');
  check('下拉菜单保留三项（无重复的更换头像项）', !r.text.includes('userMenuChangeAvatar') && r.text.includes('个人资料与头像') && r.text.includes('退出登录'), '');
  // 静态资源缓存戳：同一文件改后 mtime 变化，版本参数必须跟着变
  r = await req('GET', '/settings', { cookie });
  const vRef = (r.text.match(/app\.js\?v=([^"]+)/) || [])[1] || '';
  check('JS 引用带缓存戳（版本-mtime）', /-\w+$/.test(vRef), `v=${vRef}`);

  /* --- 删除用户及其名下全部数据 --- */
  // 开放注册 → 注册第二用户(自动建默认账本) → 记一笔(含参与成员) → 管理员彻底删除 → 数据清零
  r = await req('GET', '/settings', { cookie });
  await req('POST', '/settings/site', { cookie, form: { _csrf: csrfOf(r.text), 'site.name': '家账簿', 'site.currency': 'CNY', 'site.allow_register': '1', 'security.login_max_fail': '10' } });
  // 注册需匿名会话:req() 的 cookie 传空串会回落到当前 jar,故直接清空 jar
  const adminCookie = cookie;
  jar = '';
  r = await req('GET', '/register');
  const regRes = await req('POST', '/register', { form: { _csrf: csrfOf(r.text), username: 'victim', password: 'victim888', password2: 'victim888', display_name: '待删用户' } });
  const victimCookie = jar;
  jar = adminCookie;
  check('注册第二用户并自动登录', regRes.status === 302, `HTTP ${regRes.status}`);
  r = await req('GET', '/transactions/new', { cookie: victimCookie });
  const vCsrf = csrfOf(r.text);
  const vAcc = (r.text.match(/name="account_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  r = await req('POST', '/transactions', { cookie: victimCookie, form: { _csrf: vCsrf, type: 'expense', amount: '5.00', account_id: vAcc, txn_date: '2026-10-11', people: '测试宝宝', note: 'victim 交易' } });
  check('victim 名下记一笔(带参与成员)', r.status === 302, `HTTP ${r.status}`);

  // 切回管理员
  jar = cookie;
  r = await req('GET', '/settings', { cookie });
  const txnTotal = (s) => { const i = s.indexOf('记账总数'); const m = s.slice(i, i + 300).match(/(\d+)/); return m ? Number(m[1]) : -1; };
  check('删除前记账总数为 1', txnTotal(r.text) === 1, String(txnTotal(r.text)));
  const i2 = r.text.indexOf('待删用户');
  const uid = i2 >= 0 ? (r.text.slice(i2).match(/\/admin\/users\/(\d+)/) || [])[1] : null;
  check('定位到 victim 用户 id', !!uid, String(uid));
  r = await req('POST', `/admin/users/${uid}`, { cookie, form: { action: 'delete', hard: '1', _csrf: csrf } });
  check('彻底删除用户成功', r.status === 302, `HTTP ${r.status}`);
  r = await req('GET', '/settings', { cookie });
  check('用户列表不再含该用户', !r.text.includes('待删用户'));
  check('删除后记账总数归 0(账本连同交易一并清理)', txnTotal(r.text) === 0, String(txnTotal(r.text)));
  r = await req('GET', '/', { cookie: victimCookie });
  check('victim 会话已失效', r.status === 302, `HTTP ${r.status}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
