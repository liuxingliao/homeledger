# Proposal

## Why

用户长期使用随手记 App 记账,现希望迁移到本项目(家账簿 HomeLedger)。随手记导出的账本数据(`随手记公共账户20260914230341.xlsx`,约 910 条记录)为多工作表 Excel 格式,现有导入功能只支持支付宝/微信/通用 CSV,无法识别。需要在尽量不丢失任何数据的前提下,把随手记账本完整搬进本系统,并让系统的记录类型叫法、成员模型、报表维度与随手记的使用习惯对齐,降低迁移后的使用成本。

## What Changes

- 新增随手记 Excel(.xlsx)账单导入能力:解析多工作表(支出/收入/负债变更/代付/借入/转账/收债),全部 7 类记录入库,零依赖纯 Node 实现(不引入 Excel 解析库,保持"零原生依赖"原则)
- 按工作表语义映射交易类型:支出→expense、收入→income、转账→transfer、代付→lend、借入→borrow、收债→repay_receive、负债变更→adjust
- **交易类型显示名全局改用随手记叫法**:借出→代付、收回借款→收债、偿还借款→还款、余额调整→负债变更;并消除视图层对类型标签的硬编码(改为从 TXN_TYPES 常量派生)
- **新增随手记式自由成员**:每账本一份纯名字成员名单(不需注册用户),记一笔可多选"谁参与了这笔交易",列表展示、按参与人筛选、名单管理、删除级联
- **报表新增分组维度**:按标签分组(项目作为标签导入后可直接统计)、按参与成员分组
- 从"一级分类/二级分类"两列重建两级分类树;账户按随手记名称自动创建并推断类型(含应收/应付类账户,如"刘妈欠款"→receivable、"欠工商银行"→payable)
- 保留随手记独有字段:时间(精确到秒)、记账人、商家、备注——存入 note 与 ai_json 溯源字段;成员→参与成员;项目→标签
- 不丢失承诺:解析失败的行不得静默丢弃,需在导入结果中逐行报告;去重仅按显式指纹(日期+金额+商家),并保留完整源数据快照
- 导入入口沿用现有管理后台导入页(admin.js 的上传流程),前端 import.ejs 增加随手记格式识别与结果展示

## Capabilities

### New Capabilities

- `bill-import`: 外部账单/账本数据导入能力——格式识别(支付宝 CSV、微信 CSV、随手记 xlsx)、解析规范化、字段映射(成员→参与成员、项目→标签)、分类与账户自动创建、去重与导入报告。本变更新增随手记 xlsx 支持,并为后续其他平台预留统一格式注册点。
- `participant-members`: 随手记式自由成员名单与交易参与成员——每账本一份无需注册用户的成员名单,一笔交易可关联多个参与成员,表单多选、列表展示、按参与人筛选、名单管理(增删改、级联删除)。
- `report-dimensions`: 报表分组维度扩展——按标签分组、按参与成员分组,与既有分类/成员维度并列;空维度交易归入「未打标签」「无参与人」行,与既有「未分类」惯例一致。
- `txn-types`: 交易类型显示名对齐随手记叫法——4 个类型标签改名(lend 代付、repay_receive 收债、repay_pay 还款、adjust 负债变更),视图从 TXN_TYPES 常量派生标签、禁止硬编码;开放 API 保留旧叫法别名向后兼容。

### Modified Capabilities

(无——项目当前没有已有 spec,以上均为本变更新建)

## Impact

- **代码**:
  - `src/db.js`(TXN_TYPES 标签改名;新增 `ledger_people`、`transaction_participants` 两张表,幂等建表无需数据迁移)
  - `src/lib/txn.js`(TXN_SELECT 参与人子查询、applyParticipants/ensurePerson、按参与人过滤、tagBreakdown/participantBreakdown 聚合)
  - `src/lib/importers.js`(格式路由、importRecords 泛化支持全部 14 类交易与参与成员批量建档、导出加参与成员列)
  - `src/lib/importers-suishouji.js`、`src/lib/xlsx.js`(新增)
  - `src/routes/admin.js`(导入端点透传、参与成员名单 CRUD、账本删除清理)、`src/routes/transactions.js`、`src/routes/reports.js`、`src/routes/planning.js`、`src/routes/openapi.js`
  - 视图:`txn-form.ejs`(类型派生重构+参与成员选择)、`transactions.ejs`、`partials/txn-list.ejs`、`reports.ejs`、`members.ejs`、`accounts.ejs`、`debts.ejs`、`import.ejs`
- **数据**:新增两张表;`transactions`/`accounts`/`categories`/`tags`/`transaction_tags` 照计划写入;复用 `import_jobs` 记录导入结果;旧库重启即自动建表,无回填
- **依赖**:无新增 npm 依赖——xlsx 解析用 Node 内置 `zlib.inflateRawSync` 实现最小 zip 读取器 + 轻量 OOXML 解析
- **风险**:随手记导出不包含账户期初余额,导入后余额由流水推算,可能与随手记 App 显示不一致(记录本身零丢失);此差异需在导入结果页明确提示
