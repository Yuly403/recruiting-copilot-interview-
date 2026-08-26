---
name: recruit-grill
description: >
  逐岗逼问式梳理真实岗位需求：用一次一问的访谈把"想招什么人"从模糊说法逼成可执行的初筛标准，
  产出对外 JD、对内寻源笔记（目标公司/命脉技能/排除信号/搜索词）、CONTEXT.md 硬规则与术语表更新。
  当用户说"新开一个岗位"、"梳理 XX 岗的要求"、"帮我写 JD"，或寻源数据显示现有标准跑偏需要重梳理时使用。
---

# recruit-grill —— 逐岗梳理真实岗位需求

把用人需求从「我要一个厉害的 XX」逼问成**可执行的初筛标准**。一次只梳理一个岗位。

## 前置步骤（开始访谈前必做）

在问第一个问题前，先让 HR 理解"为什么每一项参数都重要"：
- 简要展示 [`references/screening-intake-case-study.md`](references/screening-intake-case-study.md) 中的 PQE 真实案例（3 句话版本）：
  > 填"步进电机"= AI 精准匹配电机方向的人；填"质量管理"= AI 盲筛，什么方向的质量都来；空着不填= AI 没有任何判断依据。
- 让 HR 理解：**参数填得越具体，AI 找得越准**。这一步不是走流程，是决定后续所有初筛准确度的基础。

## 访谈纪律（最重要）

- **一次只问一个问题**。问完等回答，再问下一个。一次抛一串问题会把用户问懵。
- **每个问题都给推荐答案**：基于已知信息给出"我建议是 X，因为 Y"，让用户确认或纠正，比开放题快得多。
- **能自己查到的不问**：用户已有旧 JD、公司介绍、已梳理过的其他岗位（CONTEXT.md），先读再问，只问文件里没有的。
- **追问模糊词**：用户说"要资深的"、"能力强的"、"最好懂 AI"，必须逼问成可判断的标准
  （几年算资深？看什么信号算能力强？懂 AI 是会用工具还是能落地到工作流？是硬要求还是加分项？）。
- **沉淀术语**：访谈中出现公司黑话、岗位简称、内部代号，随手写进 CONTEXT.md「术语表」，之后统一用这些词。

## 问题清单

按 [`references/question-bank.md`](references/question-bank.md) 的顺序走（有依赖关系，别乱序）。
核心八组：岗位存在意义 → 硬门槛 → 硬底子 vs 表层 → 命脉技能与验证方式 → 排除信号 → 目标公司与搜索词 → 渠道预判 → 关键词质量校验。

## 产出（每岗五件，全部写完才算梳理完）

1. **对外 JD** `01-jd/<role>.md`（可以直接发给候选人/挂平台的版本）。结构：

   ```
   # 岗位名
   > 背景一句话（为什么招）
   ## 一、招聘 spec（设计依据，内部对齐用，发布时可裁掉）
   | 维度 | 结论 |  ← 定位/核心存在意义/汇报线/学历年限/地点/薪资带宽
   ## 二、岗位详情
   | 汇报对象 | 工作地点 | 薪资 |
   > 💡 关于这个岗位（人话版描述）
   ### 岗位职责
   ### 任职要求（硬性）
   ### 加分项
   > 📌 作品集/代码/案例要求（如适用）
   ```

   ⚠️ 对外 JD 里**不写**商业敏感信息和寻源策略。

2. **对内笔记** `01-jd/_internal/<role>.md`——套 `_shared/templates/jd-internal.md`：
   硬约束一句话锚定、命脉技能与验证方式、目标公司锚点、参考简历信号、排除信号、空的关键词迭代表。
   写完提醒用户：**这份不外发**。

3. **CONTEXT.md 更新**：
   - 「初筛硬规则」：本次访谈确认的通用硬门槛（年龄线/学历线/地点坐班/错位处理）。已有内容冲突时向用户确认后更新，并在「已对齐决策」记一条带日期的变更。
   - 「在招岗位与优先级」：本岗状态从"待梳理"改为"在招"，补优先级和文件链接。
   - 「术语表」：本次新沉淀的术语。

4. **初始搜索关键词**：把访谈得出的搜索词写进对内笔记关键词迭代表的 R1 行（日期留空，首轮寻源后回填效果）。

5. **screening_intake 结构化块**：基于访谈结果，在 `01-jd/_internal/<role>.md` 底部生成结构化筛选配置，供 recruit-daily 精确读取。格式如下：

   ```yaml
   screening_intake:
     role_id: "<岗名简化>"
     daily_target_count: <每日目标人数>
     education:
       minimum: <大专|本科|不限>
       missing_evidence_action: "needs_human_review"
     age:
       enabled: <true|false>
       min: <数字|null>
       max: <数字|null>
       missing_evidence_action: "needs_human_review"
     keywords:
       must_have_keywords:
         - keyword: "<词>"
           accepted_synonyms: [<同义/缩写>]
           evidence_rule: "<简历中应出现的证据>"
           missing_action: "needs_human_review"
       preferred_keywords:
         - keyword: "<词>"
       generic_terms_to_avoid: ["沟通能力","责任心","相关经验","学习能力","经验丰富"]
   ```

   **填写规则**（全部来自 boss-hiring-assistant 关键词质量规范，详见 [`references/screening-intake-case-study.md`](references/screening-intake-case-study.md)）：
   - `must_have_keywords` 必须包含至少 1 个可在简历中核验的专业词，填什么直接问 HR 从第 18 题确认
   - 禁止将"沟通能力""责任心""相关经验""学习能力""经验丰富"单独作为 `must_have_keywords`
   - 为同义表达、英文缩写、行业别名补充 `accepted_synonyms`
   - `evidence_rule` 写清楚简历中出现什么项目/技能/职责算命中
   - `missing_action` 默认 `needs_human_review`——关键证据不足时标记人工复核，不自动淘汰
   - 学历/年龄证据不完整时同样走 `needs_human_review`，不自动淘汰

## 什么时候重新 grill

- 寻了几轮源发现标准明显不对（全是错的人/池子里根本没这种人）→ 带着台账数据重新走一遍硬门槛和命脉部分；
- 用人经理改需求 → 增量更新，改动记进「已对齐决策」。
