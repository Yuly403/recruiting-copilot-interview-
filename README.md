# Recruiting Copilot｜面试技术验证脱敏版

> 本提交版只包含源码、虚构样例和离线测试。没有账号、Cookie、Token、候选人简历、联系方式或真实聊天记录。默认不执行平台写操作。

## 1. 业务问题

招聘中真正难的不是“找到一批人”，而是把模糊需求变成可解释的标准，并在多个渠道上持续、可追溯地推进。系统先把用人经理的自然语言需求整理为结构化招聘标准，再帮助 HR 读取、初筛、审批和执行单个动作；它不把“让 Agent 自己招人”当作目标。

## 2. 为什么不能直接做“全自动招聘 Agent”

标准不清时，自动搜索只会放大噪声；发消息、交换联系方式、拒绝候选人会改变候选人体验且通常不可逆；网页点击后还可能因网络或页面变化而无法确认结果。因此，理解、读取、建议可以自动化，外发必须被审批、定位和结果核验约束。

## 3. 完整业务流程

```text
用人经理模糊需求
  → recruit-grill / CONTEXT
  → 结构化招聘标准（硬条件、核心能力、加分项、排除项、目标公司、搜索词、证据要求）
  → Agent 选择 Skill 与下一步
  → 候选人搜索 / 读取
  → LLM 按证据初筛与推荐
  → Candidate Ledger（跨平台统一事实源）
  → ActionPlan（候选人 + 岗位 + 动作 + 载荷哈希 + 定位器 + 有效期 + 幂等键）
  → Human Approval
  → Gateway
  → CLI / Driver → RPA（仅在需要页面写入时）
  → 外部平台动作 → 结果核验 → Ledger 更新或 result_unknown
```

## 4. 技术架构图

```text
Agent / 7 Skills
        │ 业务决策与 SOP
        ▼
recruitctl（Gateway CLI）
        ▼
Gateway：策略、审批、锁、幂等、熔断、审计、路由
   ┌────┴──────────────────────────────────────┐
   ▼                                           ▼
Legacy CLI Driver                         RPA Driver
   ▼                                           ▼
boss-cli                                  本机 Named Pipe Runner
   ▼                                           ▼
puppeteer-core → CDP → Chrome / Edge → BOSS DOM / iframe    原生 CDP → 页面 UI Adapter
   ▼                                           ▼
结构化读取结果                              单个受控写操作 + 结果核验
```

## 5. 7 个 Skills 的作用

| Skill | 业务作用 |
|---|---|
| `recruit-init` | 建立招聘工作区、目录和基础台账。 |
| `recruit-grill` | 追问模糊需求，产出可执行招聘标准。 |
| `recruit-daily` | 按日推进搜寻、筛选、沟通和台账。 |
| `market-talent-mapping` | 做人才市场与目标公司盘点。 |
| `resume-review` | 收集和证据化评估简历。 |
| `interview-schedule` | 组织约面和记录衔接。 |
| `ask-viy` | 不确定该走哪条流程时的路由入口。 |

## 6. Agent / Skill / CLI / Gateway / RPA / Ledger 关系

- **Agent**：理解任务、选择下一步，不直接拥有平台写权限。
- **Skill**：业务 SOP / 说明书，规定要问什么、产出什么、何时停下确认。
- **CLI**：将搜索、预览等能力做成稳定、可测试、可解析的标准接口。
- **Gateway**：不能绕过的安全闸，决定动作是否允许执行并留下记录。
- **RPA**：最后一层页面执行器 / UI Adapter，只做已批准的确定性步骤。
- **Ledger**：跨平台统一候选人事实源，记录证据、阶段、去重和动作结果。

## 7. 为什么搜索用 CLI/CDP

当前真实代码链路为：

```text
Agent → recruitctl / Gateway CLI → Legacy CLI Driver → boss-cli
→ puppeteer-core → CDP → Chrome / Edge → BOSS DOM / iframe → 结构化候选人结果
```

这不是 Playwright；`search` 和 `preview` 也没有直接调用 BOSS 内部 HTTP API。它们通过 `puppeteer-core` 连接 Chrome 的 CDP，读取页面 DOM / iframe。搜索是高频、批量、结构化读取，CLI/CDP 比全程 RPA 或纯 Web Access 更便于统一输出、解析和离线测试。自动读取仍有平台风控风险，不能宣传为“不会被检测”。

## 8. 为什么高风险写操作用 Approval + Gateway + RPA

写操作先形成 ActionPlan，再经单动作审批；Gateway 检查后才把任务交给 RPA。

```text
ActionPlan → APPROVE → Gateway → execute / commit → RPA → Result Verification
```

ActionPlan 绑定候选人、岗位、操作类型、消息 / 载荷哈希、候选人定位器、有效期和幂等键。RPA 默认演练模式；`message.commit` 等动作需要显式开启并在页面上验证结果。

## 9. 安全机制

- **幂等**：同一候选人、同一岗位、同一消息只能执行一次，避免双击或重试导致重复邀约。
- **会话锁**：一项任务操作浏览器时，另一项任务不能切换到别的候选人。
- **熔断**：出现验证码、登录异常或重复失败时停止写操作，不继续“碰运气”。
- **审计**：可回看谁批准了哪位候选人的什么动作，以及执行结果。
- **可恢复暂停 / `result_unknown`**：点击发送后若网络断开，先人工或页面核验；不因不确定而盲目重试。

## 10. 自动化等级

| 范围 | 规则 |
|---|---|
| 搜索、读取、整理 | 可自动，但受平台状态、速率和风控约束。 |
| AI 初筛、推荐 | AI 给出证据和建议，HR 复核。 |
| 发消息、交换联系方式 | 单候选人、单动作审批后执行。 |
| 标记不合适、拒绝候选人 | 禁止全自动。 |

CLI/CDP 适合高频结构化读取；RPA 适合低频、必须经过页面执行的写操作。RPA 不代表绝对安全或无法被平台识别；风险控制来自小作用域、人工审批、Gateway、幂等、定位器、锁、熔断和结果验证的组合。

## 11. Demo 怎么运行

只运行离线 synthetic 测试，不登录、不连接、不操作任何招聘平台：

```powershell
cd recruiting-gateway
npm install
npm run build
npm test
```

查看虚构业务材料：[`demo-data/`](demo-data/)。不要设置 `BOSS_RPA_ENABLE_COMMIT=true`，也不要把真实浏览器 Profile、账号或环境文件放入本目录。

## 12. 测试情况

当前源项目在本地离线回归中为 **20 个测试文件、360 项测试**；本提交版保留同一 Gateway 源码与 synthetic 测试夹具。测试验证的是协议、审批、幂等、锁、熔断、Runner 状态机和 synthetic IPC / E2E，不等于真实平台生产验证。

## 13. 当前真实成熟度

这是 **offline safety loop / synthetic E2E / engineering prototype**：7 个 Skills 已存在；Gateway 与 synthetic Runner 已由自动化测试覆盖。真实 BOSS 账号的端到端生产验证未完成。51job、猎聘没有同等级的写入 Gateway / Runner，不应表述为三平台全自动运行。当前 RPA Runner 源码在 `recruiting-gateway/src/rpa-runner/`，但未在真实 BOSS 页面完成联调。

## 14. 已知限制

详见 [`docs/limitations.md`](docs/limitations.md)。其中包括平台页面变动、风控、真实选择器和结果证据尚待受监督验证，以及多人共享机器时需要强化 Named Pipe 的 Windows ACL。

## 15. 我的职责与 AI Coding 边界

项目重点是把招聘流程拆成可审计的边界：结构化标准、证据化筛选、ActionPlan、审批、Gateway 和安全状态机。AI Coding 用于加速实现、测试和文档整理；架构取舍、安全边界、平台操作授权和最终验收仍由项目负责人判断。本提交版不把 synthetic 测试描述为生产上线。

## MCP 不是这里的主方案

自有系统有稳定 API 时，`Agent → MCP → API` 很合理。BOSS 是外部封闭平台，当前没有可用的业务 API，因此读取走 CLI/CDP，受控写操作走 RPA。技术选型取决于底层系统能力，而不是所有 Agent 都必须 MCP。

