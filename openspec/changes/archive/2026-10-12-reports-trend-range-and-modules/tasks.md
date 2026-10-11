# Tasks

## 1. 趋势随范围伸缩

- [x] 1.1 `src/lib/txn.js`:`netWorthTrend(ledgerId, months, ref = new Date())` 增加 ref 参数(内部 lastMonths 传 ref);monthlyTrend 确认 ref 链路可用。验证:lib 直调断言 2025-01~2025-06 返回 6 个月份且起止正确。
- [x] 1.2 `src/routes/reports.js`:由 range.start/end 计算月数(上限 120)与 ref,L53/L58 改为动态传参;视图标题「近 12 个月」改动态(如「近 N 个月收支趋势」「N 个月净资产走势」)。验证:HTTP 断言本月=1 点标题、全部=多月标题。
- [x] 1.3 `src/lib/charts.js`:barChart 标签抽稀(>14 隔一、>28 三取一,保留首尾;lineChart 顺带加 >28 三取一)。验证:lib 直调渲染 37 标签断言 text 数量。

## 2. 模块显隐

- [x] 2.1 `src/views/reports.ejs`:12 张卡加 `data-module` key;筛选区加「⚙ 模块设置」按钮 + 勾选浮层(含「恢复默认」);内联脚本读写 `localStorage['hl-reports-modules']` 并应用 hidden;全部隐藏时显示恢复提示。验证:HTTP 断言 data-module 数量与浮层存在。
- [x] 2.2 新增 `test/verify-reports-modules.js`(lib + HTTP)注册进 `test/run-all.js`:netWorthTrend ref、趋势标题、data-module/浮层渲染。验证:新套件绿。
- [x] 2.3 Playwright 冒烟:勾选隐藏模块即时消失、刷新后保持、恢复默认全显。验证:冒烟脚本 0 失败。
- [x] 2.4 `node test/run-all.js` 全套件 0 失败。验证:汇总行全绿。

## 3. 总览页数据时效(dashboard-recency)

- [x] 3.1 `src/routes/dashboard.js`:默认月份改为上一个自然月(显式 `?month=` 仍覆盖);收支趋势改 `monthlyTrend(ledgerId, 12, lastMonthRef)`;净资产/今日列表/订阅待扣不动。验证:lib/HTTP 断言默认区间为上月、显式 month 生效。
- [x] 3.2 `src/views/dashboard.ejs`:统计卡与支出构成文案「本月」→ 动态月份(默认标「上月」);趋势标题与口径一致。验证:页面渲染断言含「上月」。
- [x] 3.3 测试并入 `test/verify-reports-modules.js`:总览默认上月/显式月份/趋势窗口(上月止 12 个月)断言。验证:新套件绿。
- [x] 3.4 `node test/run-all.js` 全套件 0 失败。验证:汇总行全绿。

## Workflow follow-up

- 实现完成后:用 ssh-linux skill 同步改动文件到 192.168.31.18:/home/liuxl/homeledger/homeledger,重建容器,healthz + 报表页冒烟(趋势月数、模块显隐)。
