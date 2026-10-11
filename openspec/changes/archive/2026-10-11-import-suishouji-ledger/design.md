# Design: import-suishouji-ledger

## Context

现有导入链路(`src/lib/importers.js` + `src/routes/admin.js` 的 `/api/import/preview` → `/api/import/commit`)只支持 CSV:
`parseBill(buffer)` 解析文本 → `importRecords()` 直写 `transactions` 表(不经 `createTransaction`,避免逐行重算余额)→ 统一 `recalcBalances`。

随手记导出为 xlsx(zip 容器 + OOXML XML),含 7 张工作表,字段与语义均不同(见 spec)。本项目铁律:零原生依赖、零前端构建工具,因此不能引入 `xlsx`/`exceljs` 等 npm 包。

已核实的代码事实(设计依据):
- `txnEffects()`:`adjust` 对 `account_id` 产生 `delta = amount_base_cents`(可正可负);`lend/borrow/repay_*` 只影响 `account_id`;`transfer` 影响两端。
- `syncDebts()` 按 `lend/borrow` 的 `merchant` 聚合生成借还台账,`repay_receive/repay_pay` 冲抵。
- `transactions.txn_date` 只存 `YYYY-MM-DD`;`note ≤ 300`、`merchant ≤ 60`;`ai_json` 为自由 JSON。
- 导入去重指纹:`txn_date|amount_base_cents|merchant`。
- 预览数据经 `previewCache`(token)在 preview/commit 两步间传递。

## Goals / Non-Goals

**Goals**
- 纯 Node 内置(zlib + 手写最小 zip 读取器)解析 xlsx,完整读取 7 张表
- 七类记录 → 14 种交易类型的忠实映射,余额效应与现有 `txnEffects` 语义一致
- 失败行逐行报告,零静默丢失;保留原始行数据快照以便人工核查
- 复用现有 preview/commit 双阶段流程与 `import_jobs` 报告

**Non-Goals**
- 不做随手记其他导出格式(如 CSV/第三方转换器输出)的适配
- 不实现"导入后余额与随手记 App 完全一致"——导出文件不含期初余额,只能靠用户手工设置 `initial_cents` 校准
- 不改造现有支付宝/微信 CSV 逻辑(只做格式路由分发)

## Decisions

### D1. xlsx 解析:手写最小 OOXML 读取器,不引入依赖
`Buffer` 头校验 `PK\x03\x04` 识别 zip;读取 End of Central Directory 定位中央目录,用 `zlib.inflateRawSync` 解压 `sharedStrings.xml` 与各 `sheetN.xml`;正则提取 `<row>/<c>/<v>/<t>` 单元格(共享字符串、inlineStr、数字、日期样式)。约 150–200 行,放在 `src/lib/xlsx.js`。
**备选**:引入 `xlsx` 包(~1MB,含原生依赖链)——违背项目零依赖原则;要求用户先用 Excel 另存为 CSV——多一步人工操作且丢多表结构。均否决。

### D2. 格式路由:按文件魔数 + 工作表名识别
`parseBill` 前加 `detectFormat(buffer, fileName)`:zip 魔数 → 尝试读工作表名,出现"支出/收入/负债变更/代付/借入/转账/收债"中 ≥3 个 → `suishouji`;否则若文件扩展名为 .xlsx/.xls → 报"不支持的 Excel 文件";其余走现有 CSV 逻辑。预览接口的错误信息同步更新。

### D3. 随手记解析器独立模块 `src/lib/importers-suishouji.js`
不动现有 `importers.js` 的 CSV 逻辑,新文件导出:
- `parseWorkbook(buffer)` → `{ sheets: { 支出: rows[], ... }, errors[] }`
- `normalizeSsjRecords(sheets)` → `{ records[], failedRows[] }`,每条 record 含:类型、金额(分)、日期、账户 hint、to 账户 hint、分类 hint(两级)、成员/记账人/项目/商家/备注、原始行快照(存 `ai_json.source_row`)
类型映射:

| 工作表 | 交易类型 | account_id | to_account_id | merchant |
|---|---|---|---|---|
| 支出 | expense | 支出账户 | — | 商家列 |
| 收入 | income | 收入账户 | — | 商家列 |
| 转账 | transfer | 转出账户 | 转入账户 | — |
| 代付 | lend | 账户1(付款方) | 账户2(应收户) | 从备注 `#代付: X#` 提取 X |
| 借入 | borrow | 账户2(收款方) | 账户1(欠款户) | 从备注 `#借入: X#` 提取 X |
| 收债 | repay_receive | 账户2(收款方) | 账户1(应收户) | 从备注 `#收债: X#` 提取 X |
| 负债变更 | adjust | 账户1 | — | — |

### D4. 负债变更的符号处理(全量数据核对后泛化)
全量剖析:12 条负债变更 = 11 条负值(-644 ~ -100326,月度还款节奏)+ **1 条正值 +410000**(2025-03-23,早于全部负值,为债务入账)。语义:正值=债务增加、负值=债务减少。在本系统"负债账户余额 ≤ 0 表示欠款"的模型下:
- 账户为负债性质(payable/loan/credit)时:存 `-原始值`(正值 410000 → -410000,余额下降=欠款增加;负值 -1294.22 → +1294.22,余额上升=欠款减少)
- 账户为资产性质时:按原始符号存储
`ai_json.ssj_raw_amount` 始终保留原始值。实现后须用样例文件回归验证 12 条方向全部正确。

### D5. `importRecords` 泛化而非重写
在现有 `importRecords()` 上扩展:record 允许自带 `type`(不再限定 expense/income)、`account_hint`/`to_account_hint`、`category_hint`(支持"一级/二级"两段)、`tags`、`merchant`、`signed` 金额。写入仍走原直写 SQL + 末尾统一 `recalcBalances` + `syncDebts`。原 CSV 路径传旧行为参数,零回归。
分类解析:支出表一级分类作父分类、二级作子分类;收入表一级分类为常量"收入"时,直接以二级分类建一级收入分类(避免生成无意义单父层)。两级名称均 trim。

### D6. 字段保真(不丢失承诺的落点)
`txn_date` 只存日期;完整时间、成员、记账人、项目、商家、备注、原始行统一写:
- `note`:`[分类] 商家 · 成员:宝宝 · 项目:房贷 · 备注` 拼接(截 300)
- `ai_json`:`{ source: 'suishouji', sheet, row_no, datetime, member, booker, project, merchant, note, source_row }`
"项目"另建标签并写 `transaction_tags`(标签名 trim,同账本去重)。

### D7. 失败明细与报告
`importRecords` 返回值增加 `failedRows: [{ sheet, row_no, reason }]` 与按工作表统计;`import_jobs.message` 存摘要;预览接口把 failedRows 一并返回给前端展示。`import.ejs` 增加随手记来源标签与明细区块。

### D8. 自由成员与交易参与成员(新增需求)
每账本一份纯名字成员名单 `ledger_people`(UNIQUE(ledger_id,name),名字 ≤20 字),参与关系 `transaction_participants(transaction_id, person_id)` 多对多。决策:
- **查询**:TXN_SELECT 加 `participant_names` GROUP_CONCAT 子查询(仿既有 tag_names)——列表/搜索/CSV 导出零改动传播;页大小 ≤200,关联子查询成本可接受,不为它改 decorate() 的批量加载管道
- **写入**:`applyParticipants(txnId, ledgerId, input, replace)` 仿 applyTags:空格/逗号/顿号分隔、≤8 人、名字截 20;create 不 replace、update replace(与标签一致的替换语义);直接输入的新名字自动入名单
- **名单管理**:成员页(members.ejs)新增「参与成员(自由名单)」卡片,路由挂 admin.js;删除**级联**删参与行、交易不动(沿用标签删除先例 accounts.js:287-293),重命名跟随人员记录、历史归属不变;账本删除事务里清理两表
- **导入写法**:`importRecords` 事务前预热 `name→person_id` Map,循环内每个**新**名字只 INSERT 一次,再 INSERT OR IGNORE 参与行;CSV 路径无 people 字段 → 零回归;去重跳过的行不写参与人(首次导入已写过)

### D9. 报表新维度(新增需求)
- `tagBreakdown(ledgerId, start, end, kind)`:LEFT JOIN transaction_tags+tags,`COALESCE(name,'未打标签')`,按 EXPENSE/INCOME_TYPES 过滤,输出 {name,color,total,cnt} → donutChart + donutLegend(仿分类构成区块)
- `participantBreakdown(ledgerId, start, end)`:LEFT JOIN transaction_participants+ledger_people,`COALESCE(name,'无参与人')`,支出/收入两列 + `COUNT(DISTINCT t.id)`;一笔多参与人在多行各计一次(维度分析固有行为,与标签一致)→ progressBar(仿成员对比区块)
- 空维度行惯例与既有「未分类」(txn.js categoryBreakdown)一致;与"按记录人"的 memberBreakdown 各自独立,不混算

### D10. 类型标签改名与兼容(新增需求)
TXN_TYPES 仅改 4 个 label:lend 借出→**代付**、repay_receive 收回借款→**收债**、repay_pay 偿还借款→**还款**、adjust 余额调整→**负债变更**(key/icon/color/flow/group 不变,资金语义不变)。配套:
- txn-form.ejs 硬编码的 typeList/moreTypes 重构为从全局 TXN_TYPES 按 group 过滤派生(server.js 已把 TXN_TYPES 暴露为 EJS 全局)——标签单一来源
- 零散文案同步:accounts.ejs/accounts.js(余额调整→负债变更)、debts.ejs(借出→代付)、planning.js(字面量改用 TXN_TYPE_MAP[..].label)
- openapi.js 类型别名映射加新叫法,**保留旧叫法别名**向后兼容
- 报表/仪表盘图表系列名「支出/收入」未改名,不动

### D11. 随手记导入去重指纹(全量核对发现的缺陷修复)
全量剖析发现:随手记导出的「商家」列在支出/收入表 100% 为空,而支出表金额"1000.0"出现 28 次——沿用现有「日期+金额+商家」指纹会把同日同金额的两笔真实交易误判重复丢弃。决策:随手记导入的指纹改为 `txn_date|amount_cents|源时间(yyyy-MM-dd HH:mm:ss)`;重复导入同一文件时源时间相同仍全部命中跳过。实现上 importRecords 支持记录级 `dup_key` 覆盖,缺省回落到旧指纹。另两条核对结论:成员列为空 → 不建参与关系照常入库;「项目分类」常量列仅入 ai_json 不建标签。

## Risks / Trade-offs

- [手写 zip/OOXML 解析器遇到随手记未覆盖的 OOXML 变体] → 解析器只读必需字段并对未知结构容错;用真实样例文件 + 构造的边界用例(空表、合并单元格、加密文件)做单测;解析失败时报错并提示改用 CSV,不静默跳过
- [负债变更符号语义是推断,可能与随手记实际记账方向相反] → 实现后与用户在随手记 App 中抽查 2–3 条核对;映射规则集中在 normalizeSsjRecords 单处,便于修正
- [910 条记录直写后 `recalcBalances` 全量重算] → 现有实现本就是全量重算,量级无压力;保持事务包裹
- [成员无法映射为账本成员(需注册用户)] → 信息保真于 note/ai_json,报表按成员拆分功能对导入数据按"记账人=导入者"统计;spec 已注明
- [同日同金额同商家的真实两笔交易被指纹去重误杀] → 指纹与现有 CSV 导入一致,风险不变;`ai_json` 保留原始行可人工核对后手工补录

## Migration Plan

1. 新增 `src/lib/xlsx.js` 与 `src/lib/importers-suishouji.js`,扩展 `importers.js` 路由与 `admin.js` 端点,改 `import.ejs`
2. 用样例文件 `随手记公共账户20260914230341.xlsx` 走完整 preview → commit,核对 910 条与各表统计
3. 回归:支付宝/微信 CSV 各导一份走旧链路,确认行为不变
4. 回滚:纯新增文件 + 三处小改动,`git revert` 单提交即可;导入的数据可按 `source='import' AND ai_json LIKE '%"source":"suishouji"%'` 定位清理

## Open Questions

- 负债变更的正负号语义需与用户随手记 App 实际余额抽查确认(D4 已给默认规则)
- 用户的随手记账本是否还有"期初余额"信息可提供?若能提供各账户当前余额,可在导入后一键生成 `adjust` 校准交易(作为后续增强,不在本变更范围)
