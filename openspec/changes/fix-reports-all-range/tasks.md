# Tasks

## 1. 修复与回归

- [x] 1.1 `src/routes/reports.js`:`parseRange(q, ledgerId)` 接收会话账本 id,`preset=all` 分支用该参数查 `MIN(txn_date)`;路由调用处传入 `Number(ledger.id)`。验证:`node test/verify-reports-range.js` 绿。
- [x] 1.2 新增 `test/verify-reports-range.js`(8099 HTTP 隔离实例,run-all 模式):登录后经 API 记一笔历史日期交易(本月之外),断言 `/reports?preset=all` 页面含该金额、`/reports`(本月默认)不含;`preset=year` 行为不变。注册进 `test/run-all.js`。验证:新套件绿。
- [x] 1.3 全量回归 `node test/run-all.js` 全套件 0 失败。验证:汇总行全绿。

## Workflow follow-up

- 实现完成后:用 ssh-linux skill 同步改动文件到 192.168.31.18:/home/liuxl/homeledger/homeledger,重建容器,healthz + 报表页冒烟。
