# Tasks: import-suishouji-ledger

## 1. xlsx 基础解析层

- [x] 1.1 新建 `src/lib/xlsx.js`:实现最小 zip 读取器(Buffer 魔数校验、中央目录定位、`zlib.inflateRawSync` 解压),提取指定条目(如 `xl/sharedStrings.xml`、`xl/workbook.xml`、`xl/worksheets/sheetN.xml`);加密或损坏文件抛出带中文说明的错误。验证:node 单测解压真实随手记文件能列出 7 张工作表名
- [x] 1.2 `src/lib/xlsx.js` 增加 OOXML 行解析:共享字符串/inlineStr/数字/日期样式单元格 → `{ rows: string[][] }`,日期序列号转 `YYYY-MM-DD HH:mm:ss`;对空单元格、合并区域、空表容错。验证:单测断言"支出"表表头 13 列与样例行值一致(含"2026-08-31 22:33:41"时间精度)
- [x] 1.3 新建 `test/verify-ssj-xlsx.js`:针对样例文件(或提交到 `test/fixtures/` 的等价脱敏小文件)断言 7 张表行数(416/475/12/2/1/3/1 + 各自表头)。验证:`node test/verify-ssj-xlsx.js` 通过

## 2. 随手记解析与映射

- [x] 2.1 新建 `src/lib/importers-suishouji.js` 的 `parseWorkbook(buffer)`:调 xlsx 模块,按工作表名分组返回原始行;工作表缺失时按空表处理,并校验至少存在"支出/收入"之一。验证:单测返回 `{ 支出: 416行, ... }` 结构
- [x] 2.2 同文件实现 `normalizeSsjRecords()`:按 design D3 表格做类型/账户/分类映射,负数负债变更按 D4 规则归一(负债账户原始负值→正数 adjust),备注 `#代付: X#` 提取 merchant,原始行快照入 `ai_json.source_row`,分类两级 trim;无法解析的行收集到 `failedRows[{sheet,row_no,reason}]` 不抛异常。验证:单测断言 910 条零丢失、每类记录条数、一条代付记录的 type=lend 且 merchant=刘妈、一条负债变更 adjust 方向正确
- [x] 2.3 `src/lib/importers.js` 增加 `detectFormat(buffer, fileName)` 路由:zip 魔数+工作表名匹配→suishouji,.xlsx 扩展名但非随手记→明确报错,其余→现有 CSV 逻辑;`parseBill` 保持原签名兼容。验证:单测:随手记文件返回 suishouji,支付宝样例 CSV 仍返回 alipay,普通 xlsx 返回报错

## 3. 导入链路与持久化

- [x] 3.1 扩展 `src/lib/importers.js` 的 `importRecords()`:支持 record 自带 type/二级分类 hint/to_account_hint/tags/signed 金额(见 design D5),账户类型推断增加"欠"前缀/"欠款"后缀 → 应收/应付性质;原 CSV 调用路径行为不变(参数缺省走旧逻辑)。验证:单测:CSV 样例导入结果与改动前一致(条数、指纹去重、余额);随手记 records 导入后 transactions 表 type 分布与源表一致
- [x] 3.2 `importRecords()` 返回值与 `import_jobs` 写入增加:failedRows 明细、按工作表统计、source=ai_json 溯源;导入完成后调用 `syncDebts`(复用现有),借还台账按 merchant 聚合正确。验证:单测:导入样例后 `debts` 表出现"刘妈/刘志杰/润辛妈"三条且方向正确;import_jobs.message 含失败明细摘要
- [x] 3.3 `src/routes/admin.js`:`/api/import/preview` 与 `/api/import/commit` 透传新解析结果(failedRows、sheetStats、sourceLabel 增加 suishouji 条目);预览样本中随手记记录显示两级分类与原始时间。验证:用样例文件 curl/HTTP 调 preview 返回 `source=suishouji`、count=908(支出+收入)、failedRows=[];commit 后响应含 sheetStats
- [x] 3.4 `src/views/import.ejs`:格式说明区增加随手记 xlsx;结果区展示 failedRows 明细、工作表统计与"期初余额差异提示"(余额由流水推算,可在账户管理设置期初余额校准)。验证:浏览器手测导入页上传样例文件,预览、提交、报告三个状态均正确渲染

## 4. 端到端验证与回归

- [x] 4.1 新建 `test/verify-ssj-import.js`:内存/临时库跑完整 preview→commit(直接调 lib 层),断言:910 条全部入库零失败;二次导入全部跳过;分类树"日常开支/生活用品"两级存在;标签"房贷/汽车/旅游"等已建并关联;参与成员全部建档且关联正确;`ai_json` 含 datetime/booker/source_row。验证:`node test/run-all.js` 全绿
- [x] 4.2 回归旧链路:用支付宝/微信 CSV 样例分别走 preview→commit,断言导入条数、去重、余额与改动前一致。验证:现有 `test/` 全部通过 + 手测一次 CSV 导入
- [ ] 4.3 与用户随手记 App 抽查核对:随机抽 3 条交易(含 1 条负债变更)对照 App 显示的金额方向与分类;确认负债变更符号规则(D4)无需修正。验证:核对结论记录到变更目录 `verification-notes.md`(若需修正,更新 normalizeSsjRecords 与对应单测后再跑 4.1)

## 5. 自由成员/报表维度/类型改名(追加需求)

- [x] 5.1 `src/db.js`:新增 `ledger_people`、`transaction_participants` 两表(CREATE TABLE IF NOT EXISTS 幂等);TXN_TYPES 改 4 个 label(借出→代付、收回借款→收债、偿还借款→还款、余额调整→负债变更)。验证:单测断言两表存在、二次启动幂等、TXN_TYPE_MAP 新标签正确
- [x] 5.2 `src/lib/txn.js`:TXN_SELECT 加 participant_names 子查询;ensurePerson/applyParticipants(替换语义同标签);createTransaction 追加、updateTransaction 替换;buildWhere 加 personId 过滤;新增 tagBreakdown/participantBreakdown。验证:单测:记一笔带参与人、编辑替换、按人筛选、多参与人交易在维度统计中各计一次、无参与人/未打标签行存在
- [x] 5.3 `src/views/txn-form.ejs`:硬编码 typeList/moreTypes 重构为从 TXN_TYPES 按 group 派生;成员 disabled 下拉改为记录人只读 + 参与成员输入(name=people,datalist 建议+名单 chips 点选追加);`src/lib/formdata.js` 加 people;`src/routes/transactions.js` readForm 加 people、列表加 personId 筛选。验证:浏览器手测记一笔/编辑/筛选
- [x] 5.4 `src/views/transactions.ejs`(person 筛选下拉+qs 映射)、`partials/txn-list.ejs`(参与:xxx 展示)、`src/views/members.ejs` + `src/routes/admin.js`(参与成员名单卡片与 CRUD,删除级联、重名拒绝;账本删除清理两表)。验证:手测 + 单测级联删除
- [x] 5.5 报表两维度:`src/lib/txn.js` 聚合(5.2)+ `src/routes/reports.js` 取数 + `src/views/reports.ejs` 两张新卡(按标签 donut、按参与人 progressBar,空态文案)。验证:单断言 SQL 结果;手测报表页
- [x] 5.6 改名零散文案:`accounts.ejs`/`accounts.js`(负债变更)、`debts.ejs`(代付)、`planning.js`(改用 TXN_TYPE_MAP label)、`openapi.js`(新叫法别名,保留旧叫法兼容)、CSV 导出加「参与成员」列。验证:单测 openapi 新旧别名均可解析;手测相关页面文案
- [x] 5.7 新建 `test/verify-people-participants.js` 并注册 `test/run-all.js`(连同 verify-ssj-xlsx/verify-ssj-import)。验证:`node test/run-all.js` 全绿

## Workflow follow-up

- 全部实现后:代码合入远程NAS `/home/liuxl/homeledger/homeledger`,按 README 编译/启动并修复问题直至正常运行
- 归档前用样例文件在真实账本做一次完整导入演练(用户确认数据无误后再上线使用)
- 后续增强(不在本变更):导入后按用户提供的各账户当前余额一键生成校准 adjust 交易;随手记其他账本批量迁移
