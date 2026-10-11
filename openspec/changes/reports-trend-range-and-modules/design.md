# Design

## Context

- `monthlyTrend(ledgerId, months, ref)` 已支持自定义月数与 ref(util.lastMonths 以 ref 当月为尾);`netWorthTrend(ledgerId, months)` **无 ref 参数**,固定相对今天。
- 路由 L53/L58 固定传 12;range 对象含 start/end。
- `trendBreakdown`(txn.js L560+)已有 from/to → 起止解析先例。
- barChart 标签从不抽稀;lineChart 已有 `n>14 隔一显示`(charts.js L137)。
- reports.ejs 12 张卡均无 id;页面无内联脚本;app.js 有 sessionStorage try/catch 先例(L643)。
- settings 表是全局 key-value,无用户维度 → 本机记忆走 localStorage(用户已确认)。

## Goals / Non-Goals

**Goals:**
- 两张趋势图按 range 起止月展示;标题动态。
- 12 个模块可勾选显隐,localStorage 记忆,可恢复默认。

**Non-Goals:**
- 不做跨设备/账号级偏好(settings 表无用户维度,不做迁移)。
- 不做模块拖拽排序。
- 每日支出走势、星期分布等不在伸缩范围(它们已随 range)。

## Decisions

### D1 趋势月数与 ref 由 range 推导
路由新增小函数:由 range.start/end 求月份差 `months = (end年-起年)*12 + (end月-起月) + 1`,上限 120;`ref = new Date(end年, end月-1, 1)`。`monthlyTrend(ledgerId, months, ref)` 直接可用;`netWorthTrend` 增加 ref 参数(默认 new Date(),向后兼容),内部 `lastMonths(months, ref)`。
**备选**:改造两函数接受 start/end——netWorth 逐月累计逻辑以月序列为核心,传 ref 即可,改动最小。

### D2 barChart 标签抽稀对齐 lineChart
`n > 14 && i % 2 !== 0 && i !== n-1` 时跳过标签文本(柱子保留);>28 时每 3 取 1。lineChart 已有逻辑,顺带把 >28 三抽一也加上(36 点时标签 12 个)。

### D3 模块显隐:data-module + localStorage
- 12 张卡逐个加 `data-module="stats|compare|trend|donut|rank|tags|people|daily|weekday|members|networth|accounts"`(顶部筛选卡不参与)。
- 筛选区右侧加「⚙ 模块设置」按钮,点击弹出内联浮层(`<div class="hidden">` 切换):每组一行 `<label><input type="checkbox" data-mod-key="...">模块名</label>` + 「恢复默认」。
- 内联脚本(transactions.ejs 同款模式):加载时读 `localStorage['hl-reports-modules']`(JSON 数组,存隐藏的 key;空/缺失=全显),对 `[data-module]` 应用 hidden;勾选变化即写回;「恢复默认」清 key 全显。try/catch 兜底隐私模式(仿 app.js L643 先例)。
- grid-2 两列布局:隐藏一卡后另一卡仍占列——用 grid 自动回流(grid 列定义不变,隐藏卡 display:none 后剩余卡自动补位)。

### D4 测试
- lib:netWorthTrend 带 ref 的序列断言(2025-01~2025-06 → 6 个月份);monthlyTrend ref 可用性。
- HTTP:页面含 data-module 12 个、模块设置浮层、趋势标题动态文本;localStorage 行为属浏览器域,由 Playwright 冒烟覆盖(勾选→隐藏→刷新保持→恢复默认)。

## Risks / Trade-offs

- [localStorage 被清空/换设备偏好丢失] → 可接受(用户已确认本机记忆)。
- [模块全部隐藏后页面空] → 全部隐藏时显示一条「所有模块已隐藏,可在模块设置中恢复」提示。
- [netWorthTrend 大范围点多] → 120 月上限;折线渲染无压力。
- [同名模块 key 与视图强耦合] → key 常量集中在视图头数组,脚本与卡片同源渲染。

## Migration Plan

纯代码/视图改动,无数据迁移;远端同步重建容器。

### D5 总览页默认月份 = 上一个自然月(新增需求)
`dashboard.js` 的默认月份从 `monthOfToday()` 改为上月(`monthOfToday` 函数改为返回上月,或路由内计算 `ref` 减一个月——实现取后者,保留函数原语义供他处使用);显式 `?month=` 仍覆盖默认。收支趋势改 `monthlyTrend(ledgerId, 12, lastMonthRef)`(monthlyTrend 已支持 ref)。统计卡与支出构成图文案「本月」→「上月」(显式选月时跟随所选月)。**边界**:净资产卡(实时快照)、今日交易列表、订阅「本月待扣」(前瞻预测)均不动。

## Open Questions

(无——粒度/存储/交互/总览时效均已确认。)
