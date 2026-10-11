# Design

## Context

- `src/routes/reports.js` 的 `parseRange(q)` 在 `preset === 'all'` 分支用 `Number(q.ledger_id) || 0` 查询 `MIN(txn_date)`;报表路由实际账本来自 `auth.requireLedger` 注入的 `res.locals.ledger`,URL 不携带 `ledger_id` → 恒按 `ledger_id = 0` 查询 → 查无交易 → 起点回退 `${curMonth}-01`,「全部」退化为本月。
- 其余 preset(month/quarter/year/custom)不使用 ledger_id,不受影响。

## Goals / Non-Goals

**Goals:**
- 「全部」按会话账本计算最早交易日期,统计覆盖全部历史。
- 补齐回归测试,防再犯。

**Non-Goals:**
- 不改动其余 preset 的语义与视图;不动报表聚合 SQL(它们本就正确接收 range)。

## Decisions

### D1 parseRange 增加显式 ledgerId 参数
`parseRange(q, ledgerId)`,路由处传 `Number(ledger.id)`;`preset=all` 分支改用该参数。**备选**:保留 q.ledger_id 并让视图在 URL 上补 `ledger_id`——把账本标识暴露进 URL、且每个 preset 链接都要改,扩大改动面,放弃。

### D2 测试挂 HTTP 端到端
在 `test/verify-salary-allocation.js` 同款 8099 隔离实例模式上新增断言太杂——改为独立小套件 `test/verify-reports-range.js`(HTTP):先建历史交易(默认账本),访问 `/reports?preset=all` 与 `/reports`(本月),断言「全部」页面出现历史金额而本月为空;再断言 `preset=year` 行为不变。注册进 `run-all.js`。

## Risks / Trade-offs

- [改动 parseRange 签名影响其他调用方] → grep 确认仅 reports.js 一处调用;签名向后兼容(可选参数)。
- [账本无任何交易时起点回退] → 保留现有 `|| \`${curMonth}-01\`` 兜底,行为不变。

## Migration Plan

单文件修复 + 测试,无数据迁移;远端同步重建容器即可。

## Open Questions

(无)
