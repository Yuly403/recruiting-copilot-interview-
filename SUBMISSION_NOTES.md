# 面试验证脱敏说明

- 本目录由 Recruiting Copilot 当前源码复制而来，原项目未被修改。
- 所有岗位、候选人、公司、消息和 ActionPlan 均为虚构 synthetic 数据。
- 未包含账号、登录态、Cookie、Token、API Key、浏览器 Profile、手机号、邮箱、真实简历或真实聊天记录。
- 保留的真实实现：Gateway、Legacy CLI Driver、`boss-cli` 的 Puppeteer/CDP 浏览器适配代码、RPA Runner、7 个 Skills 和自动化测试。
- 未包含：历史网页抓取研究包、运行时目录、浏览器 Profile、会话目录、旧助手目录、真实环境文件和构建产物。
- 与外部 OCR 凭据有关的可选模块已从提交副本移除；保留的 `Token`、`Cookie` 只出现在安全边界说明中，不含任何值。
- RPA Runner 源码已包含，但只完成离线 / synthetic 验证；不宣称真实 BOSS 端到端生产验证。
- 51job、猎聘仅作为业务扩展接口与台账场景说明，不包含同等级写操作实现。
