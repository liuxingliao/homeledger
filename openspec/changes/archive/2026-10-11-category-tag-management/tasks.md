# Tasks

## 1. 路由层

- [x] 1.1 `src/routes/accounts.js`:`POST /tags/:id` 增加重名防护(同账本同名且非自身 → flash 错误不覆盖);`POST /tags/:id/delete` 有关联交易时拒绝删除并提示数量;`POST /categories/:id` 移除 `is_system` 拦截;`POST /categories/:id/delete` 移除 `is_system` 拦截,删除语义改为「分类自身或子分类有引用 → 拒绝并提示数量;无引用 → 硬删,父分类连带子分类」。验证:HTTP 断言各路径行为。
- [x] 1.2 标签/分类删除前的引用计数口径:分类含全部子分类、标签按 transaction_tags 关联数;确认拒绝提示文案带数量。验证:lib/HTTP 断言提示内容。

## 2. 视图层

- [x] 2.1 `src/views/tags.ejs`:每个标签加「编辑」按钮与内联表单(名称 + 颜色 + 保存),仿 acc-edit 展开模式。验证:页面渲染 + 提交改名改色生效。
- [x] 2.2 `src/views/categories.ejs`:一级/二级分类(系统/自建)均加「编辑」(名称/图标/颜色内联表单)与「删除」入口;顶部提示文案更新(内置分类可改可删、改名全局生效)。验证:页面渲染 + 编辑系统分类生效。

## 3. 回归与部署

- [x] 3.1 新增 `test/verify-category-tag-mgmt.js`(lib + HTTP):标签改名/改色/重名防护/有关联拒删/无关联可删;系统分类改名生效、有引用(含子分类)拒删并提示数量、无引用可删(父子齐);注册进 `test/run-all.js`。验证:新套件绿。
- [x] 3.2 `node test/run-all.js` 全套件 0 失败。验证:汇总行全绿。

## Workflow follow-up

- 实现完成后:用 ssh-linux skill 同步改动文件到 192.168.31.18:/home/liuxl/homeledger/homeledger,重建容器,healthz + 标签/分类管理页冒烟。
