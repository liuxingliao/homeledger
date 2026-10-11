# Spec Delta: txn-types

## Purpose

交易类型显示名对齐随手记叫法,降低迁移用户的学习成本;同时消除视图层对类型标签的硬编码,保证标签唯一来源是 TXN_TYPES 常量。

## ADDED Requirements

### Requirement: 类型显示名采用随手记叫法
交易类型显示名 SHALL 全局改用随手记叫法(仅改显示名,类型的 key、图标、颜色、资金流向、分组不变):

| key | 原显示名 | 新显示名 |
|---|---|---|
| lend | 借出 | 代付 |
| repay_receive | 收回借款 | 收债 |
| repay_pay | 偿还借款 | 还款 |
| adjust | 余额调整 | 负债变更 |

其余 10 个类型显示名不变。改名 SHALL 全局生效:列表、表单、筛选下拉、导出、开放 API 文档等所有展示处。

#### Scenario: 全局生效
- **WHEN** 用户打开记一笔页、交易筛选下拉、账户的余额调整入口与借还台账页
- **THEN** 相应类型显示为「代付/收债/还款/负债变更」,不再出现旧叫法

#### Scenario: 语义不变
- **WHEN** 记一笔「代付」(lend)
- **THEN** 交易的资金流向、余额效应与改名前完全一致(仅显示名变化)

### Requirement: 视图标签单一来源
视图与路由 SHALL 通过 TXN_TYPES/TXN_TYPE_MAP 常量(或其派生的 type_label)获取类型显示名,SHALL NOT 硬编码类型中文标签;开放 API SHALL 同时接受新旧叫法作为类型别名,保证既有调用方兼容。

#### Scenario: 表单不再硬编码
- **WHEN** 未来修改 TXN_TYPES 中任一类型显示名
- **THEN** 记一笔页的类型按钮与全部下拉自动跟随,无需改动视图文件

#### Scenario: 开放 API 兼容
- **WHEN** 调用方通过开放 API 以旧叫法"借出"或新叫法"代付"指定类型
- **THEN** 两种叫法均解析为 lend 类型
