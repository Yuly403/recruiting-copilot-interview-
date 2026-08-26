---
name: recruit-daily
description: >
  每日招聘流水线：把"查 boss+猎聘+51job 未读 → 三通道主动寻源 → 硬规则初筛 → 打招呼 → 补台账 → 出日报"
  串成一条流水线。当用户说"处理今天的招聘"、"有没有未处理人选"、"帮我找找 X 岗的人"、
  "给合适的人打招呼"、"出今天的招聘日报"，或在招聘工作区做任何寻源/初筛/建档动作时使用。
---

# recruit-daily —— 每日招聘流水线

每日主力动作：把 Boss 直聘 + 猎聘 + 前程无忧三个渠道的「查未读 → 主动寻源 → 初筛 → 打招呼 → 建档 → 出日报」串成一条流水线。

**这是编排文档**：CLI 命令细节见 [`references/channels.md`](references/channels.md)，
台账与日报格式见 [`references/ledger-and-report.md`](references/ledger-and-report.md)，
打招呼话术模板见 [`references/message-templates.md`](references/message-templates.md)。
本文档只管「顺序、判断、跨渠道协同、安全」。

**重要：所有 Boss 直聘操作统一走 `recruitctl` Gateway**，不再直接调用 `boss` CLI。
Gateway 命令格式：`recruitctl <操作> [--name <名>] [--job <岗>] [--query <词>] [--plan <计划文件>] [--payload-file <消息文件>]`。
写操作（打招呼、发消息、索要附件等）需 `--plan` 和 `--payload-file`：先创建计划 JSON 和消息文本文件，再 `recruitctl` 执行。
猎聘和前程无忧的**只读**操作仍走各自 CLI；由于尚未接入同等强度的审批、幂等与结果核验链路，写操作只生成待办并由招聘人员在浏览器中手工完成。

## 铁律：先读事实源，别凭记忆

开工**先读**（都在工作区根下）：
- `CONTEXT.md` —— 术语、**初筛硬规则**、**在招岗位与优先级**（唯一事实源，随时可能更新）。
- `AGENTS.md` —— 分工与「不可逆动作等确认」红线。
- `01-jd/_internal/<role>.md` —— 各岗命脉技能 / 排除信号 / **关键词迭代表**（寻源前必读，越搜越准）。

**本文档不写任何硬规则数字**——年龄线、学历线、地点要求全部以 CONTEXT 为准，避免两处打架。
如果 CONTEXT 硬规则区还是空的（没跑过岗位梳理），停下来先走 `skills/recruit-grill/SKILL.md`。

## 主流程（按需跳步）

1. **查未处理**：
   - `recruitctl candidates.listUnread`（角标 > 0 才有）
   - `liepin chatlist --json`，过滤 `unread_count` 非 "0"。
   - `wuyou chatlist --json`，过滤 `unread` 非 0。
   - **有未读**：逐个按 CONTEXT 硬规则判 → 该回复的回复、该要简历的要、
     该排除的**先记台账等用户确认**（绝不自动点"不合适"）。
   - **没未读**：转主动寻源。

2. **定寻源岗位与优先级**：读 CONTEXT「在招岗位与优先级」，按优先级分配今天的额度。

3. **三通道寻源**（每个目标岗都跑），命令与坑见 channels.md：
   - **boss**：`recruitctl candidates.search --job <岗> --query <词>` + `recruitctl candidates.recommend --job <岗>`。
   - **猎聘**：`liepin joblist --json` 拿 ejobId → `liepin search "<词>" --city <城市> --json` + `liepin recommend --json`。
   - **前程无忧**：`wuyou joblist --json` 拿职位列表取 `jobid` → `wuyou search "<词>" --city <城市> --jobid <职位ID> --json`（无推荐入口，search 覆盖全国池）。首次使用前确保 `wuyou login` 已完成。
   - 搜索词用 `_internal/<role>.md` 关键词迭代表里最新一轮的有效词。
   - **完成判据**：每个目标岗，boss 与猎聘各自的 search + recommend、51job 的 search 都跑过——漏一个渠道或入口 = 没做完。
     CONTEXT 里若已沉淀"某岗某渠道无效"的结论，可按结论跳过并在日报注明。

4. **硬规则初筛**（三段式证据驱动判断）：

   先读：`CONTEXT.md`「初筛硬规则」+ `01-jd/_internal/<role>.md` 的「命脉技能」「排除信号」**和 `screening_intake` 结构化块**。

   **第一段：硬条件（硬性不达标 = 直接排除）**
   - 年龄超出排除线 → `hard_constraint_unmet`
   - 学历不达标且无等效学历 → `hard_constraint_unmet`
   - 地点明确不符 → `hard_constraint_unmet`
   - 薪资带宽明显错位 → `hard_constraint_unmet`
   - ⚠️ 学历/年龄信息在简历中不可靠 → **不进本段**，降到第三段做 `needs_human_review`

   **第二段：关键词证据匹配（默认继续，仅标记）**
   - 对照 `screening_intake.keywords.must_have_keywords` 逐词匹配
   - 每词检查：`keyword` 本身或任一 `accepted_synonyms` 在简历中出现即算该词命中
   - 全部命中 → `recommended`
   - 部分命中 → `keyword_evidence_insufficient`（标记**等人工确认**，不自动淘汰）
   - 全未命中 → `needs_human_review`（标记等 HR 判断，不自动淘汰）
   - ⚠️ **铁律**：关键词缺失 ≠ 候选人不合格。简历写作风格差异、岗位名称不同等都可能导致关键词不出现。**绝不因为关键词没命中就自动淘汰候选人。**

   **第三段：加分项与最终评级**
   - 对照 `screening_intake.keywords.preferred_keywords` 逐词匹配
   - 对照对内笔记「排除信号」校验
   - 综合评级：⭐（勉强过）~ ⭐⭐⭐（强匹配，命脉全部命中+加分词命中）
   - 判定顺序：硬条件 → 命脉关键词 → 排除信号 → 评级
   - 最终处置：只有 `hard_constraint_unmet` 不进推荐列表；`keyword_evidence_insufficient` / `needs_human_review` 进"待人工确认"分区，等其他标记的全部确认后再统一决策

5. **打招呼**（对外不可逆——先读下方安全规则）。Boss 走 Gateway 三段式链路；猎聘和前程无忧只生成带候选人、岗位和话术的人工待办。
   - 话术从 [`references/message-templates.md`](references/message-templates.md) 的参数化模板选取，不临时生成长文本。
   - 变量填 `{{candidate_name}}`、`{{job_title}}`、`{{company_name}}` 等，不硬编码。
   - **完成判据**：每个过筛人选要么已打招呼、要么记了跳过原因（硬规则/额度/已联系过），逐一回报，无静默遗漏。

6. **补台账** `02-sourcing/dedup-ledger.csv`。优先用不可逆的 `来源记录键` 精确去重；姓名+岗位只作为疑似重复提示，必须人工核对后才能合并。格式见 ledger-and-report.md。台账是**唯一事实源**。
   - **完成判据**：本轮接触过的每个候选人在台账里有且仅有一行；无重复候选人键、来源记录键和序号；按岗位计数与本轮处理人数对得上。

7. **出日报**：
   - 本机有 `lark-cli` 且已配置 → 飞书云文档；
   - 没有 → 写本地 `runtime/reports/YYYY-MM-DD.md`。
   - 两种载体结构相同，见 ledger-and-report.md。内容**从台账同步**，不另立事实源。
   - **完成判据**：日报含今日概况数字、按岗人选表、待用户确认清单三块，且文档链接/文件路径已回给用户。

8. **回填关键词迭代表**：从本轮「初筛通过/强匹配」的真实简历反向提取搜索词，
   写回 `01-jd/_internal/<role>.md` 的迭代表（有效词/无效词/积极信号/拒绝模式）。下轮先读它。
   - **完成判据**：今天每个出过「初筛通过」人选的岗位，迭代表都新增了一行。

## 打招呼安全规则（对外不可逆，最重要）

### 发送前确认
- **每个候选人逐个确认**，不接受把“合适的直接打招呼”当成跨候选人的技术审批凭证；每份 ActionPlan 只绑定一个候选人、一个岗位、一个操作和一份消息载荷。

### 话术规则
- **不临时生成**：从 `references/message-templates.md` 的参数化模板中选取，只填变量不写正文。
- **变量必校验**：发送前确认 `{{candidate_name}}` 匹配当前线程的候选人、`{{job_title}}` 匹配当前岗位。
- **约束要求**：句子短、专业友好、不索要私人联系方式、不承诺 offer 或薪资、不捏造公司政策。
- **首次触达、索要附件、约面、拒绝**四个关键节点走固定模板，不允许自由生成。

### 权益耗尽优先诊断（最高优先级）
- 出现"前 1~3 人成功 + 后续连续失败"模式时，**第一优先级不是怀疑 selector 或 CLI 问题**，而是先判断：
  - 当日沟通权益是否已耗尽
  - 页面/API 返回是否存在额度/权益/套餐提示
- 确认权益耗尽 → 进入 `paused_for_contact_quota_exhausted`，记录已发送人数 + 剩余候选人名单，停止发送。
- **不要继续测试更多发送方式**，不要反复重试。

### 批量规则
- 单轮最多准备 5 份独立计划，但必须逐份交互审批和执行，相邻发送间随机短暂停顿。
- 每发送 2~3 人做一次轻量状态校验（检查是否触发验证码/账号异常）。
- 达到权益上限立即暂停并汇报。

### 平台特定规则
- **Boss 三段式**：先 `recruitctl plan.create ... --payload-file <msg.txt>`，再由招聘人员在真实终端运行 `recruitctl approve --plan <plan.json> --payload-file <msg.txt>`，最后才执行 `recruitctl greeting.commit --plan <plan.json> --payload-file <msg.txt>`。计划不支持候选人列表。
- **猎聘 / 前程无忧**：禁止 Agent 调用 `liepin greet` 或 `wuyou greet`；在同等安全网关落地前，由招聘人员在浏览器中手工发起沟通。
- **遇风控 / 账号异常 / 验证码**：立即停，不硬闯，报告用户。
- **商业敏感信息**（CONTEXT 里标注敏感的内容）**不写进对外话术和日报**；
  对外提及公司/产品名前跟用户核对口径。
- **打招呼是按职位的**：同一人换岗可重复打；打前用 chatlist / 台账去重，
  别重复骚扰（尤其猎聘对已建会话会重发消息）。
- **遇每日沟通额度上限**（付费弹层）：停下问用户，别自己决定花付费权益。

## 什么时候不用本流程

- 新开岗位 / 改标准 → `skills/recruit-grill/SKILL.md`。
- 本地收到的简历（猎头/内推/直投），或飞书邮箱猎聘/BOSS/51job 简历收取与评估 → `skills/resume-review/SKILL.md`。
- 某岗深度市场盘点 → `skills/market-talent-mapping/SKILL.md`。
- 约面试 / 改期 → `skills/interview-schedule/SKILL.md`（建日程前必经用户确认）。
- 发 offer、谈薪 → 完全等用户明确指令，逐案处理。
