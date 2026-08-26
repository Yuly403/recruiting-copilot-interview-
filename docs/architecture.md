# 架构与调用边界

从需求到动作的主线是：先由 `recruit-grill` 把自然语言需求沉淀到 CONTEXT，再以硬条件、核心能力、加分项、排除项、目标公司、搜索词和证据要求约束搜索与筛选。标准不足时应继续追问，不让 Agent 直接自动化。

读取链路的真实代码在 `recruiting-gateway/src/drivers/legacy-cli/` 与 `boss-cli-source/src/browser/`：Gateway 的 Legacy CLI Driver 启动 `boss-cli` 子进程；`boss-cli` 使用 `puppeteer-core` 通过 Chrome DevTools Protocol 连接或启动本机 Chrome / Edge，并从 BOSS DOM / iframe 取得页面信息。没有 Playwright，也没有针对 `search` / `preview` 的 BOSS 内部 HTTP API 调用。

写入链路的真实代码在 `recruiting-gateway/src/gateway/`、`src/drivers/rpa/` 和 `src/rpa-runner/`：Gateway 完成计划校验、审批、锁和路由后，经本机 Named Pipe 将受限任务交给 Runner。Runner 用原生 CDP 与 UI Adapter 执行页面最后一步；它不是通用浏览器 Agent。

Candidate Ledger 属于工作区业务事实层，跨平台保留候选人标识、证据、状态和动作结果；平台页面是读取来源，不是跨平台事实源。

