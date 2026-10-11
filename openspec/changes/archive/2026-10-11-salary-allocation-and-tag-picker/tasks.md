# Tasks

## 1. 数据层与分配计算

- [x] 1.1 `src/db.js`:`ensureColumn('accounts','alloc_ratio','INTEGER NOT NULL DEFAULT 0')` 幂等迁移;重复 init 不报错。验证:新库/老库(手工删列模拟)各 init 一次,列存在且幂等。
- [x] 1.2 lib 层新增 `computeAllocation(totalCents, accounts)`(design D3:floor 分配 + 余数按比例降序/并列取 id 升序逐户补 1 分,仅取 ratio>0 的 other 账户)。验证:verify 测试覆盖整除、非整除余数不丢分、并列比例、ratio=0 不参与。

## 2. 保存路径(lib + 路由)

- [x] 2.1 `src/lib/txn.js` 新增 `createSalaryAllocation(ledgerId, userId, {totalCents, common, accounts})`:校验 Σratio===100、总额>0、存在未停用 other 账户;`tx()` 内循环 `createTransaction`(type=income,共享日期/分类/标签/备注/参与成员/`group_id`,design D4)。验证:verify 测试断言生成笔数、各笔金额精确、余额经 recalcBalances 正确、Σratio≠100 时零交易且报错、失败整体回滚。
- [x] 2.2 `src/routes/transactions.js`:readForm 解析 `mode=salary` 与总金额;POST 分支调 createSalaryAllocation,校验失败回显错误不产生交易,成功 flash「生成 N 笔」并 redirect(design D4)。验证:HTTP 或 lib 层测试走通成功/比例错误/空金额三条路径。

## 3. 账户比例配置

- [x] 3.1 `src/routes/accounts.js`:创建/编辑接受 `alloc_ratio`(other 校验 0~100 整数,非法回 0;非 other 强制 0)。验证:POST 其他账户比例 30 后数据库为 30;对 debit 账户提交比例仍为 0。
- [x] 3.2 `src/views/accounts.ejs`:编辑表单 other 账户显示「分配比例(%)」输入;新建表单类型选「其他」时联动显示。验证:页面渲染 other 有输入项、储蓄卡无;配置后记一笔工资可读到新比例。

## 4. 记一笔表单(工资收入模式 + 标签选择)

- [x] 4.1 `src/views/txn-form.ejs`:「更多类型」区加「💰 工资收入」入口(design D5);激活后隐藏账户下拉,按 `form.accounts` 渲染 other 账户行(名称、`(余额)`、预览额、未设置比例标注);无 other 账户时提示并阻止提交;再次点击或点其他类型恢复原表单。
- [x] 4.2 `public/js/app.js`:salary 模式 JS——金额输入联动 computeAllocation 同规则预览;提交携带 `mode=salary` 仅传总金额。验证:浏览器手测(或 webapp-testing)输入 10000.00、比例 30/30/40 预览显示 3000/3000/4000;改金额实时刷新。
- [x] 4.3 `src/views/txn-form.ejs`:标签输入加 `<datalist id="tags-datalist">`(数据 form.tags)+ chips 快速加入(仿参与成员模式,design D6)。验证:已有标签出现在可选列表且选择后入库;手输新标签照常创建。

## 5. 回归与文档

- [x] 5.1 新增 `test/verify-salary-allocation.js`(lib 层,含 computeAllocation/createSalaryAllocation/比例校验/余额/标签选择入库)并注册进 `test/run-all.js` SUITES。验证:`node test/verify-salary-allocation.js` 绿;`node test/run-all.js` 全套件 0 失败。

## Workflow follow-up

- 实现完成后:用 ssh-linux skill 将代码同步到 192.168.31.18:/home/liuxl/homeledger/homeledger,按远端 README 重新构建容器并启动(用户要求"上传测试"),healthz + 冒烟验证工资分配与标签选择。
