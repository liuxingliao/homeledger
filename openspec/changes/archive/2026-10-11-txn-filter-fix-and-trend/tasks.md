# Tasks

## 1. 筛选链路修复(lib + 路由)

- [x] 1.1 `src/lib/txn.js` buildWhere:keyword 数字时按金额值匹配(元→分精确等值 + 原 LIKE 兜底);categoryId 支持数组(展开子分类并集)。验证:lib 直调断言「88.5 命中 8850」「双分类并集含子分类」。
- [x] 1.2 `src/routes/transactions.js`:GET / 读 `category_id` 数组与 `q || keyword` 兜底;抽出 `parseFilterQuery(query)` 供 trend 端点复用。验证:HTTP 断言双分类筛选结果与翻页保持。

## 2. 视图修复与筛选增强

- [x] 2.1 `src/views/transactions.ejs`:qs() 补 `keyword→q`;表单补 kind/month/from/to/source/reimbursable hidden 字段;分类 select 加 multiple;新增标签下拉(数据 form.tags);「清空」清掉全部参数。验证:页面渲染断言 + 手测翻页/提交不丢条件。
- [x] 2.2 新增筛选回归套件(lib + HTTP)注册进 `test/run-all.js`:条件组合、翻页保持 q=、金额搜索、多选分类、标签筛选。验证:新套件绿。

## 3. 走势图

- [x] 3.1 `src/lib/txn.js` 新增 `trendBreakdown(ledgerId, f)`:粒度自动适配(≤31 天按日,否则按月);选中分类每分类一条(≤8 条,取分类色),未选时支出/收入两条;返回 `{labels, series:[{name,color,data}]}`。验证:lib 直调断言粒度切换与聚合值。
- [x] 3.2 `src/routes/transactions.js`:GET / 复用 parseFilterQuery 计算 trend 并传入视图(实现时改为服务端渲染,免 fetch)。验证:HTTP 断言页面含走势 SVG 与图例属性。
- [x] 3.3 `src/lib/charts.js` lineChart:circle 与图例项加 `data-series` 属性(不改现有 reports 观感);`src/views/transactions.ejs` 加走势图入口按钮 + 展开卡(服务端预渲染 SVG)+ 图例点击高亮/变暗 JS(再点恢复)。验证:浏览器手测或 webapp-testing——悬浮数值、多线配色、图例聚焦;回归全绿。

## 4. 回归与部署

- [x] 4.1 `node test/run-all.js` 全套件 0 失败。验证:汇总行全绿。

## Workflow follow-up

- 实现完成后:用 ssh-linux skill 同步改动文件到 192.168.31.18:/home/liuxl/homeledger/homeledger,重建容器,healthz + 交易明细页冒烟(筛选翻页、走势图)。
