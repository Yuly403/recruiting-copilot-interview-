/** 业务实现聚合出口：impl* 供 CLI 与其它模块调用 */
import { runLogin } from './login.js';
import { runGetCandidateList } from './list.js';
import { runListOpenPositions } from './jd.js';
import { runOpenCandidateChat, runOpenCandidateChatByIndex } from './chat.js';
import {
  runChatActionOnCurrentConversation,
  type ChatPageAction,
} from './action.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { runBossSearch, runBossSearchSet } from './deep-search.js';
import { runNormalSearch } from './normal-search.js';
import { runRecommend } from './recommend.js';
import { runPreview } from './preview.js';
export type { ChatPageAction };
export type { DeepSearchGeekItem } from './deep-search.js';

export async function implLogin(): Promise<string> {
  return runLogin();
}

export async function implListCandidates(): Promise<string> {
  return runGetCandidateList();
}

export async function implListUnreadCandidates(): Promise<string> {
  return runGetCandidateList({ unreadOnly: true });
}

export async function implOpenChat(
  candidateName: string,
  exact: boolean,
): Promise<string> {
  return withBossSessionPage(async (page) => runOpenCandidateChat(page, candidateName, exact));
}

export async function implOpenChatByIndex(params: {
  index: number;
  unreadOnly?: boolean;
  expectedName?: string;
  exact?: boolean;
}): Promise<string> {
  return withBossSessionPage(async (page) =>
    runOpenCandidateChatByIndex(page, {
      index: params.index,
      filter: params.unreadOnly ? 'unread' : 'all',
      expectedName: params.expectedName,
      exact: params.exact,
    }),
  );
}

export async function implChatAction(params: {
  action: ChatPageAction;
  remark?: string;
}): Promise<string> {
  if (params.action === 'not-fit') {
    throw new Error('标记不合适不可自动执行，请由招聘人员在浏览器中手工完成。');
  }
  if (params.action !== 'resume' && params.action !== 'history') {
    throw new Error('Boss 直接写操作已禁用，请使用 recruitctl 的 ActionPlan + 交互审批链路。');
  }
  return withBossSessionPage(async (page) => runChatActionOnCurrentConversation(page, params));
}

export async function implSendMessage(_params: {
  text: string;
  requestResume?: boolean;
}): Promise<string> {
  throw new Error('Boss 直接发信已禁用，请使用 recruitctl message.commit。');
}

export async function implListPositions(): Promise<string> {
  return runListOpenPositions();
}

export async function implListPositionsWithOptions(opts: {
  detail?: boolean;
  name?: string;
}): Promise<string> {
  return runListOpenPositions({
    detail: opts.detail,
    detailName: opts.name,
  });
}

export async function implBossSearch(
  opts: {
    jobKeyword?: string;
    coreRequirements?: string[];
    bonusRequirements?: string[];
    match?: boolean;
  } = {},
): Promise<string> {
  return runBossSearch(opts);
}

export async function implNormalSearch(keyword?: string, jobKeyword?: string): Promise<string> {
  return runNormalSearch(keyword, jobKeyword);
}

export async function implBossSearchSet(opts: {
  jobKeyword?: string;
  coreRequirements?: string[];
  bonusRequirements?: string[];
}): Promise<string> {
  return runBossSearchSet(opts);
}

export async function implRecommend(jobKeyword?: string): Promise<string> {
  return runRecommend(jobKeyword);
}

export async function implPreview(opts: {
  candidateTarget: string;
}): Promise<string> {
  return runPreview(opts);
}

export async function implRecommendGreet(_opts: {
  candidateTarget: string;
  jobKeyword?: string;
}): Promise<string> {
  throw new Error('Boss 直接打招呼已禁用，请使用 recruitctl greeting.commit。');
}

