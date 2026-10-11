# Design

## Context

- 缺陷链路(transactions.ejs):`qs()`(行 2–11)把 `f.keyword` 原样输出为 `keyword=`,后端只读 `q=` → 翻页/快捷 chips 丢关键词;筛选表单(行 34–83,GET)缺 kind/month/from/to/source/reimbursable 隐藏字段 → 提交清掉快捷条件;金额搜索按 `CAST(amount_base_cents AS TEXT)` LIKE(txn.js:87–91),元写法永不命中;tagId 后端支持但无 UI;分类筛选单选(select)。
- 可复用:`charts.lineChart({labels, series:[{name,color,data}], height, fill, valueUnit})`(charts.js:92)已支持多序列/颜色/自动图例/渐变/SVG `<title>` 悬浮值(reports.ejs:232–246 为现成调用样例);`buildWhere` 已支持 from/to、tagId、personId 等;`res.locals.charts/helpers` 全局可用。

## Goals / Non-Goals

**Goals:**
- 筛选条件在翻页/表单提交/快捷切换三个动作下都不丢。
- 走势图完全跑在既有 SVG 图表体系上,不引入前端图表库。

**Non-Goals:**
- 不改后端存储与列表 SQL 的整体结构(仅扩展条件)。
- 不做 JS 浮层 tooltip(沿用 `<title>` 原生悬浮,与净资产走势一致)。
- 不做分类多选的树形勾选 UI(select multiple 即可)。

## Decisions

### D1 筛选修复:qs 映射 + hidden 字段 + 金额按值
1. `qs()` 映射表增加 `k === 'keyword' ? 'q'`。
2. 表单内补 hidden inputs(kind/month/from/to/source/reimbursable,当前 f 有值才输出),提交不再清掉快捷条件。
3. 金额匹配:keyword 为可解析数字时,换算成分的精确串与 `CAST(amount_base_cents AS TEXT)` 做 `=`(外加原有 LIKE 兜底);「88.5」→ 8850 命中。
4. 标签筛选:表单加 `<select name="tag_id">`(数据 form.tags,已按使用频次排序)。

### D2 分类多选:select multiple + 数组条件
- 分类 select 加 `multiple`(保持 optgroup 两级结构),不选 = 全部;多选时提交 `category_id=1&category_id=2`。
- `buildWhere`:categoryId 支持数组 → `(t.category_id IN (…含各子分类展开) OR t.category_id IN (SELECT id FROM categories WHERE parent_id IN (…)))` 展开并集;路由读 `[].concat(req.query.category_id)`。
- 上限保护:图表序列 ≤8 条,超出取金额前 8。

### D3 走势图:独立 JSON 端点 + lineChart 增强
- 走势数据由服务端计算并直接渲染进视图(f 在服务端已知,免 fetch;路由复用抽出的 `parseFilterQuery` 与 `txn.trendBreakdown(ledgerId, f)` 返回 `{labels, series:[{name,color,data}]}`):
  - 粒度:range ≤31 天按日(strftime '%Y-%m-%d'),否则按月('%Y-%m');范围起点取 f.month/from,终点取 f.to/today。
  - 序列:选中分类 → 每分类一条(金额绝对值合计,分类名做线名,颜色取 category color,缺省用调色板);未选 → 「支出」「收入」两条(fixed colors)。
  - 聚合走一条 GROUP BY SQL,分类维度用 CASE/分组两查均可,在 txn.js 新增 `trendBreakdown(ledgerId, f)`。
- `charts.js` lineChart:每个 `<circle>` 与图例项增加 `data-series` 属性(值=序列下标);图例项改为可点的 `<g class="legend-item" data-series="i">`(样式微调,不改reports 现有观感)。
- 交互 JS(transactions.ejs 内联,或 app.js 的 initTxnForm 同层新增):点图例 → 容器内所有 `[data-series]` 加/去 `.dim` 类(CSS opacity .15),被点序列除外;再点恢复。展开区域:`<details>` 或按钮切换 hidden 的 card,首次打开 fetch trend.json 后插入 SVG(innerHTML),缓存到已展开状态。

### D4 测试策略
- lib 层:buildWhere 多选分类/金额匹配/trendBreakdown 聚合粒度,直调断言(独立 DATA_DIR)。
- HTTP 层:trend.json 返回结构、筛选翻页保持 keyword(q=)、hidden 字段存在性;注册 run-all。

## Risks / Trade-offs

- [select multiple 移动端体验一般] → 保留单选习惯:点一个即单选,Ctrl/长按多选;文档提示。
- [旧书签含 keyword= 参数失效] → 路由同时接受 q 与 keyword 兜底(`req.query.q || req.query.keyword`)。
- [SVG 图例点击的可访问性] → legend-item 补 role/键盘事件可选;初版先 mouse/touch。
- [trend.json 大范围按日点过多] → 粒度规则保证 >31 天必按月,点数可控。

## Migration Plan

纯代码 + 视图改动,无数据迁移;远端同步重建容器即可。

## Open Questions

(无——图表位置/多线语义/粒度均已确认。)
