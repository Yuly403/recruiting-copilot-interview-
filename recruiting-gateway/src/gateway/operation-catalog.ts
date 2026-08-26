import type { Operation, DriverType, OperationType } from '../contracts/enums.js';

// ── Operation Catalog (per PRD §7) ──

export interface OperationDefinition {
  operation: Operation;
  type: OperationType;
  description: string;
  /** Default primary driver */
  primary: DriverType;
  /** Default fallback driver */
  fallback: DriverType;
  /** Whether approval is required */
  approvalRequired: boolean | 'manual_login' | 'policy' | 'when_match';
  /** Whether automatic retry is allowed */
  autoRetry: boolean;
  /** Max retry count for reads */
  maxRetries: number;
  /** Whether to retry when result is unknown */
  retryWhenResultUnknown: boolean;
  /** Whether automation (no human) is allowed */
  automationAllowed: boolean;
}

const catalog: Record<Operation, OperationDefinition> = {
  'session.login': {
    operation: 'session.login',
    type: 'session',
    description: '打开BOSS登录页，扫码由用户完成',
    primary: 'legacy_cli',
    fallback: 'human',
    approvalRequired: 'manual_login',
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'session.status': {
    operation: 'session.status',
    type: 'local_read',
    description: '汇总Gateway runtime、锁、Driver健康',
    primary: 'gateway_local',
    fallback: 'human',
    approvalRequired: false,
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'positions.list': {
    operation: 'positions.list',
    type: 'read',
    description: '获取岗位列表',
    primary: 'legacy_cli',
    fallback: 'rpa',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'jd.get': {
    operation: 'jd.get',
    type: 'read',
    description: '获取岗位JD',
    primary: 'legacy_cli',
    fallback: 'rpa',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'candidates.list': {
    operation: 'candidates.list',
    type: 'read',
    description: '全部聊天列表',
    primary: 'legacy_cli',
    fallback: 'rpa',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'candidates.listUnread': {
    operation: 'candidates.listUnread',
    type: 'read',
    description: '未读聊天列表',
    primary: 'legacy_cli',
    fallback: 'rpa',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'candidates.search': {
    operation: 'candidates.search',
    type: 'read_navigation',
    description: '搜索候选人',
    primary: 'legacy_cli',
    fallback: 'human',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'candidates.deepSearch': {
    operation: 'candidates.deepSearch',
    type: 'read_navigation_limited',
    description: '深度搜索（消耗权益）',
    primary: 'legacy_cli',
    fallback: 'human',
    approvalRequired: 'when_match',
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'candidates.recommend': {
    operation: 'candidates.recommend',
    type: 'read_navigation',
    description: '推荐候选人',
    primary: 'legacy_cli',
    fallback: 'human',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'candidate.preview': {
    operation: 'candidate.preview',
    type: 'read_limited',
    description: '预览候选人（消耗额度）',
    primary: 'legacy_cli',
    fallback: 'rpa',
    approvalRequired: 'policy',
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'conversation.open': {
    operation: 'conversation.open',
    type: 'navigation',
    description: '打开候选人会话',
    primary: 'legacy_cli',
    fallback: 'rpa',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'conversation.read': {
    operation: 'conversation.read',
    type: 'read',
    description: '读取会话内容',
    primary: 'rpa',
    fallback: 'human',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'message.stage': {
    operation: 'message.stage',
    type: 'reversible_write',
    description: '填写消息但不提交',
    primary: 'rpa',
    fallback: 'human',
    approvalRequired: true,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'message.commit': {
    operation: 'message.commit',
    type: 'irreversible_write',
    description: '提交/发送消息',
    primary: 'rpa',
    fallback: 'human',
    approvalRequired: true,
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'greeting.commit': {
    operation: 'greeting.commit',
    type: 'irreversible_write',
    description: '发送打招呼消息',
    primary: 'rpa',
    fallback: 'human',
    approvalRequired: true,
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'attachment.request': {
    operation: 'attachment.request',
    type: 'irreversible_write',
    description: '索要附件/简历',
    primary: 'rpa',
    fallback: 'human',
    approvalRequired: true,
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'attachment.accept': {
    operation: 'attachment.accept',
    type: 'state_write',
    description: '接收附件/简历',
    primary: 'rpa',
    fallback: 'human',
    approvalRequired: 'policy',
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'remark.update': {
    operation: 'remark.update',
    type: 'state_write',
    description: '更新备注',
    primary: 'rpa',
    fallback: 'human',
    approvalRequired: true,
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'contact.exchange': {
    operation: 'contact.exchange',
    type: 'irreversible_write',
    description: '交换联系方式',
    primary: 'rpa',
    fallback: 'human',
    approvalRequired: true,
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'candidate.markNotFit': {
    operation: 'candidate.markNotFit',
    type: 'irreversible_write',
    description: '标记不合适（禁止自动执行）',
    primary: 'human',
    fallback: 'human',
    approvalRequired: true,
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: false,
  },
  'execution.verify': {
    operation: 'execution.verify',
    type: 'read_verification',
    description: '验证执行结果',
    primary: 'current_write_driver',
    fallback: 'human',
    approvalRequired: false,
    autoRetry: true,
    maxRetries: 1,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
  'execution.stop': {
    operation: 'execution.stop',
    type: 'control',
    description: '停止/取消当前Driver',
    primary: 'gateway_local',
    fallback: 'human',
    approvalRequired: false,
    autoRetry: false,
    maxRetries: 0,
    retryWhenResultUnknown: false,
    automationAllowed: true,
  },
};

export function getOperationDefinition(operation: string): OperationDefinition {
  const def = catalog[operation as Operation];
  if (!def) {
    throw new Error(`Unknown operation: ${operation}`);
  }
  return def;
}

export function getAllOperations(): OperationDefinition[] {
  return Object.values(catalog);
}

export function isReadOperation(type: string): boolean {
  return ['read', 'read_navigation', 'read_navigation_limited', 'read_limited', 'local_read', 'navigation'].includes(type);
}

export function isWriteOperation(type: string): boolean {
  return ['reversible_write', 'irreversible_write', 'state_write'].includes(type);
}

export function isIrreversibleWrite(type: string): boolean {
  return type === 'irreversible_write';
}
