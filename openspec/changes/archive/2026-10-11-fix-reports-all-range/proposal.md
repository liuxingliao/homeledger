# Proposal

## Why

报表分析页选择「全部」时间范围时没有数据:范围解析在计算最早交易日期时,错误地使用了 URL 查询串里的 `ledger_id`(`Number(q.ledger_id) || 0`),而报表页的真实账本 id 来自会话(`res.locals.ledger`),URL 从不携带该参数 → 实际按 `ledger_id = 0` 查询 → 查不到任何交易 → 起点回退为「本月 1 号」。于是「全部」退化成只查本月,本月无交易时页面所有统计全部为空。

## What Changes

- `src/routes/reports.js` 的 `parseRange` 改为接收真实账本 id(由路由传入 `res.locals.ledger.id`),`preset=all` 时用正确账本查询 `MIN(txn_date)` 作为「全部时间」起点。
- 行为修正:「全部」统计覆盖账本全部历史交易(从最早交易日期到今天),本月无交易时不再显示为空。- 回归测试:覆盖 preset=all 在「本月无交易、历史有交易」场景下的范围与统计。

## Capabilities

### New Capabilities

- `report-time-range`: 报表分析页的时间范围选择(本月/本季度/本年/自定义/全部)——「全部时间」SHALL 按会话账本从最早交易日期计算起点,覆盖全部历史;补齐此前从未被规格化的时间范围行为。

### Modified Capabilities

(无——`report-dimensions` 只覆盖分组维度(标签/参与成员),不含时间范围;时间范围行为此前无任何规格。)

## Impact

- `src/routes/reports.js`:`parseRange(q)` → `parseRange(q, ledgerId)`,仅 line 35 的 `preset=all` 分支受影响;其余 preset(month/quarter/year/custom)不使用 ledger_id,行为不变。
- 测试:`test/` 新增或扩展一个覆盖 preset=all 的回归断言(可挂在 verify-salary-allocation.js 同款 HTTP 模式或 lib 直调)。
- 无数据库、无依赖变更;不涉及远端数据结构。
