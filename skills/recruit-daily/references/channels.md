# 三通道寻源命令与坑

命令细节的权威是 `recruitctl --help` / `liepin help` / `wuyou help`；这里只放**编排流程实际用到的调用形态**和实测踩过的坑。
三个渠道的登录态持久化；首次使用各跑一次登录（`recruitctl session.login` / `liepin login` / `wuyou login`）。

## Boss 直聘（`recruitctl` Gateway）

**所有 Boss 操作统一走 Gateway**，不再直接调用 `boss` CLI。

| 目的 | 命令 |
|---|---|
| 查未读 | `recruitctl candidates.listUnread` |
| 岗位槽位（拿"开放中"岗位名做 `--job` 匹配） | `recruitctl positions.list` |
| 人才库搜索（**姓名打码**，全网牛人） | `recruitctl candidates.search --query <关键词> --job <岗位>` |
| 推荐池（**姓名不打码**，每人标「可打招呼/已打招呼」） | `recruitctl candidates.recommend --job <岗位>` |
| 在线简历预览（**耗每日查看额度**，按需） | `recruitctl candidate.preview --name <姓名> --displayed-name <显示名>` |
| 生成单次写计划 | `recruitctl plan.create --operation greeting.commit --candidate-key <本地ID> --name <显示名> --job-ref <岗位> --source <来源> --list-context-hash <列表哈希> --payload-file <msg.txt>` |
| 人工交互审批 | `recruitctl approve --plan <plan.json> --payload-file <msg.txt>` |
| 执行已审批招呼 | `recruitctl greeting.commit --name <姓名> --plan <plan.json> --payload-file <msg.txt>` |
| 打开会话 | `recruitctl conversation.open --name <姓名>` |
| 索要附件/简历（写操作） | `recruitctl attachment.request --name <姓名> --plan <plan.json> --payload-file <msg.txt>` |

**写操作固定顺序**：`plan.create → approve → commit`。不要手写 `approved`，不要修改审批后的计划或消息文件；任何字段或字节变化都会使签名/哈希失效。`--source` 只能是 `inbound_chat`、`recommended_feed`、`search_results`、`deep_search` 之一。`plan.create` 输出的 `plan` 路径用于后两步。

关键行为与坑：
- **search + recommend 配对**：每个目标岗 search 和 recommend 都要跑，漏一个入口 = 没做完。search 覆盖面广但姓名打码，recommend 姓名不打码可精确打。
- **已打过的人卡片按钮是「联系Ta」**——Gateway 会自动跳过，不算失败。
- **取简历**：顺序执行、每批 3-5 人；失败重试一次，仍失败标"未获取"，别反复重试烧时间。
- **浏览器恢复**：Gateway 底层浏览器出问题时结束对应进程即可，下条命令自动重启且仍登录。

## 猎聘（`@viyzhu/liepin-cli`，招聘者端，`--json` 友好）

| 目的 | 命令 |
|---|---|
| 查未读 | `liepin chatlist --json`（过滤 `unread_count` 非 "0"） |
| 拿 ejobId（打招呼要绑职位） | `liepin joblist --json` |
| 搜索（返回 resume_id/im_id/user_id/age/degree...） | `liepin search "<关键词>" --city <城市> --json` |
| 推荐（**无 age 字段**，年龄硬规则难核） | `liepin recommend --json` |
| 投递池 | `liepin talent` |
| 查简历 | `liepin resume <talentId>` |
| 打招呼 | **仅人工浏览器操作；Agent 禁止调用 `liepin greet`** |

关键行为与坑：
- `search`/`recommend` 输出的 JSON 前面有非 JSON 前缀（"正在跳转…"），解析时从第一个 `[` 截取。
- 人工打招呼时仍需核对 `resume_id` 与 `ejobId`，但不得由 Agent 直接执行写命令。
- **recommend 无 age 字段**：如果 CONTEXT 有年龄硬规则，推荐池难核验——谨慎打，优先 search。
- **greet 前查 `liepin chatlist` 或台账去重**：对已建会话会**重发消息**，别重复骚扰已联系的人。
- 猎聘候选人的 `resume_id` 只用于当次只读查询；台账的 `来源记录键` 写入 `liepin + 账号作用域 + resume_id + jobRef` 的 SHA-256，不在备注中落原始 ID。后续需要再次查看时重新只读定位。

## 前程无忧（`wuyou-cli`，招聘者端，`--json` 友好）

| 目的 | 命令 |
|---|---|
| 查未读 | `wuyou chatlist --json`（过滤 `unread` 非 0） |
| 拿职位列表 | `wuyou joblist --json` |
| 搜索（返回 resume_id/name/age/degree/current_company/current_position/expect_salary/skills...） | `wuyou search "<关键词>" --city <城市> [--jobid 职位ID] --json` |
| 查简历 | `wuyou resume <resume_id>` |
| 打招呼 | **仅人工浏览器操作；`wuyou greet` 已在 CLI 层禁用** |
| 聊天列表/消息 | `wuyou chatlist --json` / `wuyou chatmsg <resume_id>` |

关键行为与坑：
- **首次使用需 `wuyou login`**：CDP 打开浏览器，人工扫码一次，之后登录态自动持久化。无需重复登录。
- **search 列表信息密度最高**：返回的 JSON 直接包含 `current_company`（当前公司）、`current_position`（当前职位）和 `skills`（技能标签），**不需逐个点开简历即可初判命脉**。搜索效率三平台最高。
- **搜索 API 带 MD5 签名**：每个请求需 32-char `sign` 字段，由 wuyou-cli 内部自动从页面状态提取并计算，无需手动维护。
- 自动写入和 DOM 兜底已停用；人工操作前通过 chatlist 与台账去重。
- **资产状态需关注**：`mall/order/pop` 接口返回点数余额，"资产不足"时需用户确认是否充值。
- **51job 无 recommend 入口**：与 Boss/猎聘不同，前程无忧没有独立的"推荐"入口。search 即覆盖全国人才池，完成判据中 51job 只需 search 一个入口。
- **简历 ID 字段**：51job 搜索结果中的 `resume_id` 与猎聘字段同名但作用域不同，只能用于各自平台的当次只读查询。写台账时将平台、账号作用域、原始 ID 和 jobRef 一起哈希为 `来源记录键`，不保存原始 ID，避免混用和不必要的数据暴露。
- **search 可选 `--jobid`**：部分企业账号搜索时必须带 `--jobid`（从 `wuyou joblist` 获取），否则返回空或报错。不带时 CLI 会尝试裸搜但可能失败。

## 渠道分工

哪个岗位哪边池子肥，是**跑出来的结论不是猜的**：每轮寻源后把"某岗某渠道有效/无效"的观察
写进你自己的 `CONTEXT.md`（渠道结论沉淀在"已对齐决策"或岗位表备注），下轮按结论分配精力。
没有结论之前，每岗两边都跑。

## 浏览器 / 稳定性坑

- **Gateway 底层浏览器出问题时**：结束对应进程（登录态持久化），下条命令自动重启且仍登录。不要多工具同时连同一调试端口。
- **后台跑批量 greet 别用管道过滤**（`| sed` / `| tail`）再落文件——管道要等 EOF 才输出，
  会误判"空/卡住"；要么前台跑给足超时，要么全量落文件事后再筛。
- **平台改版高频**：选择器失效、新弹层出现是常态。命令报错先升级（`npm update -g` 对应 CLI 包），
  再看是不是平台改版，别自己写浏览器脚本硬闯。
