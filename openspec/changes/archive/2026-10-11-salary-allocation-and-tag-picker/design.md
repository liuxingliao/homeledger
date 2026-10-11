# Design

## Context

- 余额规则:`recalcBalances` 完全从交易推导(`balance = initial_cents + Σ txnEffects`),直接 UPDATE accounts 加钱会被下次重算抹掉——分配必须落成交易。
- 「一笔交易只能挂一个 account_id」(`src/lib/txn.js` createTransaction),且 `txnEffects` 按类型硬编码、`default` 分支按支出扣钱——新增交易类型 key 牵动面大。
- 现成模板:`markReimbursed`(`src/lib/txn.js:256`)在 `tx()` 事务内循环 `createTransaction` 生成多笔;`group_id` 列与索引已存在,可串联同一次分配的多笔。
- 表单数据已就绪:`form.accounts` 含 `type` 与 `balance_cents`;`form.tags` 已按使用次数排序返回。
- 迁移模式:`ensureColumn`(src/db.js)幂等加列。

## Goals / Non-Goals

**Goals:**
- 工资收入一键按比例分配到「其他」账户,预览与落账金额精确一致、不丢分。
- 比例配置只对 other 类型账户暴露,数据随账户保存。
- 标签输入可选可填。

**Non-Goals:**
- 不新增交易类型 key、不改报表口径(生成的是普通 income 交易,报表自动覆盖)。
- 不做「按组整体编辑/撤销一次分配」——生成后各笔独立管理。
- 不支持小数百分比(整数 0~100)。

## Decisions

### D1 工资收入 = 表单模式,不新增 TXN_TYPE
「工资收入」是记一笔页「更多类型」区的一个**独立 UI 入口**(独立 chip,不属于 TXN_TYPES),激活后切换表单为分配模式;保存生成的是 type=`income` 的普通交易。
**理由**:用户已确认"每账户各记一笔收入"。若新增 `salary` 类型 key:txnEffects default 会扣钱、INCOME_TYPES/金额正负号/报表/开放 API 全要跟改,而账面上并不存在挂 salary 类型的持久交易,报表和筛选会出现空类型。表单模式零波及,且不违反 txn-types 规格的"标签单一来源"约束(它不是交易类型)。
**备选**:新增类型 key 并在 createTransaction 内魔法展开成多笔——编辑/删除/导出语义全变复杂,放弃。

### D2 比例存储:`accounts.alloc_ratio INTEGER NOT NULL DEFAULT 0`
`ensureColumn('accounts','alloc_ratio','INTEGER NOT NULL DEFAULT 0')` 幂等迁移;取值 0~100 整数百分比。UI 仅对 `type==='other'` 的账户暴露(编辑表单常显、新建表单在类型选到「其他」时显示),服务端保存时同样只接受 other 账户的该字段(非 other 一律写 0)。
**理由**:整数百分比 + 总和=100 校验简单可靠、无浮点;工资分配场景够用。
**备选**:basis points(支持小数)——当前需求无此精度,留作后续演进。

### D3 分配计算:服务端权威,余数从大比例账户依次补 1 分
共享计算函数 `computeAllocation(totalCents, accounts)`(lib 层):`each = floor(totalCents * ratio / 100)`,余数 `total - Σ each` 按比例降序(并列取 id 升序)逐账户补 1 分。前端 JS 用同一规则做实时预览;**提交只传总金额**,服务端重算并落账,不信任客户端分配值。规格"预览与保存一致"以该共享规则保证。
**测试**需覆盖:整除、非整除余数、并列比例、总和校验。

### D4 保存路径:POST 分支 + 事务内循环 createTransaction
表单以隐藏字段 `type=salary` 标识工资模式(金额输入即总金额;salary 仅是表单模式值,不是交易类型)。`src/routes/transactions.js` 的 POST 检测到 `type=salary` 后走独立分支:
1. 校验:存在未停用 other 账户;Σalloc_ratio===100(否则 flash 错误并回显,不产生任何交易);总金额 > 0。
2. `createSalaryAllocation(ledgerId, userId, {totalCents, common, accounts})`(lib 层,仿 markReimbursed):`tx()` 内先 `computeAllocation`,再循环 `createTransaction`(type=income,各笔挂对应账户,共享 日期/分类/标签/备注/参与成员/`group_id`)。
3. 事务保证全成或全不成;成功后 flash 提示生成 N 笔,redirect 同现有。
**备选**:单笔多账户交易 + 扩展 txnEffects——类型系统不支持,放弃。

### D5 表单 UI(salary 模式)
`src/views/txn-form.ejs`:「更多类型」chips 区加「💰 工资收入」入口(`data-mode="salary"`,非类型按钮);激活时:隐藏 `#acc-label`+`#f-account` 下拉(及 transfer 的转入账户),渲染 other 账户行列表(名称 + `(余额)` + 预览额 + 未设置比例标注),金额输入联动预览(`public/js/app.js`);分类/日期/标签/备注/参与成员照常。无 other 账户时行区显示引导提示并阻止提交。退出入口(再点一次或点其他类型按钮)恢复原表单。
比例配置 UI:`src/views/accounts.ejs` 编辑表单(other 账户显示比例输入)+ 新建表单(类型联动显示);`src/routes/accounts.js` 创建/编辑 UPDATE 接受 `alloc_ratio`(other 校验 0~100,非 other 强制 0)。

### D6 标签选择:纯前端,复用参与成员模式
`txn-form.ejs` 标签输入(现 `name="tags"` 纯文本)加 `<datalist id="tags-datalist">`(数据 `form.tags`)并在输入框下以 chips 快速加入(仿 people 输入 65-75 行 + 298-307 行的现成模式)。后端 `applyTags` 语义不变,零后端改动。

## Risks / Trade-offs

- [前端预览与服务端计算不一致] → 服务端始终重算落账;verify 测试断言 computeAllocation 的整数规则(含余数、并列),预览逻辑同一规则内联。
- [一次分配生成 N 笔收入使列表变长] → 共享 group_id 便于追溯;属预期行为(用户已确认每账户一笔)。
- [用户改比例后旧分配不受影响] → 比例在保存时点生效,历史交易不改写,符合直觉。
- [alloc_ratio 对非 other 账户残留脏值] → 保存路由强制非 other 写 0;计算只取 other。
- [多笔交易的 CSRF/回显失败路径] → 失败整体回滚(事务),回显 salary 模式与已填字段。

## Migration Plan

1. `ensureColumn` 幂等加列,老库无感(默认 0)。
2. 部署顺序无依赖:代码合并 → 远端重建容器 → healthz + 冒烟(记一笔工资收入、账户比例配置、标签选择)。
3. 回滚:回退镜像即可,新增列留置无害。

## Open Questions

(无——落账方式、总和校验、默认比例均已与用户确认。)
