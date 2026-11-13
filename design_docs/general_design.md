# 牌局引擎设计

引擎负责发牌、摸打、行动窗口、响应裁决和结算；规则适配器负责判胡、最高番胡法及基础赔付。普通和血战共用状态机，差异见 [血战设计](blood_battle_design.md)。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `TileWall` | 按规则牌池生成、洗牌、抽牌和查询剩余张数 |
| `PlayerState` | 真实手牌及稳定 ID、副露、弃牌、分数和退出状态 |
| `GameConfig` | 本局固定的模式和一炮多响配置 |
| `GameState` | 阶段、窗口、摸牌身份、动作执行和结果 |
| `action_options` | 枚举合法动作及所需牌值 |
| `ActionResolver` | 响应优先级和同级席位裁决 |
| `RuleAdapter` | 将规则计算器结果归一为稳定 `WinResult` |
| `ScoringAdapter` | 根据赢家、付款人和基础赔付生成平衡结算 |
| 房间运行层 | 成员/席位、鉴权、串行调度、连接、暂停和托管 |
| 前端 | 显示、输入、本地布局及实体选择 |

手牌整理在前端本地完成，不发请求，顺序随正式出牌提交；后端验证全部正式动作，超时按权威顺序最右实体出牌，见 [手牌整理](hand_order_design.md)。

## 规则合同

牌值使用 `0..20`、`24`、`+`、`×`；图片和展示对象不进入规则输入。同值实体用不同 `tile_id` 区分，数组位置不能替代身份。

主要接口：

```text
evaluate_win(hand_snapshot, win_context) -> WinResult
```

`HandSnapshot` 包含手牌牌值和副露。`WinContext` 包含赢家、胡牌张、自摸/点胡/抢杠方式、来源和独立天胡条件。

`WinResult` 区分牌型成立与满足起胡门槛，返回最高番分组、胡型、番种、总番、起胡番、封顶番、基础赔付、规则标识及错误。自摸使用实际摸牌 ID 对应牌值，不因拖动替换同值实体。

内置适配器为 `ArithmeticMahjongRuleAdapter`，可注入其他符合合同的实现。听牌及其他规则的统一 Adapter 入口尚未完成。

## 配置与流程

`GameConfig` 不可变，默认普通模式、一炮多响开启。房间开局前确定模式、规则和计时，安排下一局时可改，进行中锁定。

```text
INIT → DEALING → WAITING_DRAW → WAITING_TURN_ACTION
出牌 → WAITING_RESPONSE
吃胜出 → WAITING_ACTION_DETAIL
加杠且有人可抢 → WAITING_ROB_KONG
胡牌或流局 → SETTLING → ROUND_ENDED
```

四席各发 13 张，庄家先摸牌。无人认领弃牌则下一有效席摸牌；吃碰后直接出牌，杠成功后补摸。动作、实体和计时规则见 [Action 与 Timeout](action_timeout_design.md)。

后端已确认顺序随真实牌张增减维护。所有 t3 超时取后端最近权威快照最右实体；前端按 ID 删除该牌，保留当前本地排列，不补发排序消息。

## 结算

`NormalScoringAdapter` 和 `BloodBattleScoringAdapter` 消费规则适配器提供的 `base_payment`，不重复计算番种。

- 点胡由点炮者付一份基础赔付；普通自摸由其他三家各付一份，血战只由尚未胡的对手付款。
- 一炮多响为每位赢家生成独立 `SettlementEvent`，来源玩家分别付款。
- 抢杠由加杠者付款，保留碰组，只移除被抢实体，不完成加杠或补摸。
- 普通流局无赢家及新增赔付；血战流局保留此前结算和分数。
- 更新分数前验证全部赢家、付款人和收支平衡，失败不能只改部分玩家。
- 诈胡赔付尚未实现。

`SettlementEvent` 记录结算 ID、赢家、来源、`WinResult` 和分数变化。最终 `RoundResult` 汇总局 ID、结束原因、庄家/下局庄家、赢家、结算、总分变化和最终状态，公开最高番胡法、番种和付款明细。

普通模式有赢家即结束，血战累计三位赢家或牌山摸空结束。`SETTLING` 是后端同步内部阶段，不等待客户端动画。

## 下一局

结算后供查看，由房主手动安排并确认下一局。保留四个计分座位的分数，创建新 `round_id`，庄家固定轮换：

```text
next_dealer_seat = (dealer_seat + 1) % 4
```

`start_next_round(..., source_round_id=...)` 仅在上一局结束后调用；清理旧牌张、窗口、提示、计时和本地布局关联，再洗牌发牌。胜负、流局和换人不改变固定轮庄。

## 视图与扩展

玩家视图按权限过滤，不公开他人暗牌、未裁决意向和未来牌山。服务器检查点见 [状态快照](state_recovery_design.md)。

Bot 通过观察和合法候选返回动作，由可信执行层校验，不直接修改 `GameState`，见 [Bot 设计](bot_design.md)。房间、身份和协议见 [联机设计](multiplayer_design.md)。
