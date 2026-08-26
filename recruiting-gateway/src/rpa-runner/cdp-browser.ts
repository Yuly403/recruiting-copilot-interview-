import type {
  BossBrowserFactory,
  BossBrowserSession,
  BrowserPageState,
  CandidateSnapshot,
} from './contracts.js';
import type { CandidateLocator } from '../contracts/action-plan.js';

interface CdpTarget {
  id?: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface Point {
  x: number;
  y: number;
}

/** Minimal CDP client built on Node's native WebSocket. It deliberately has no browser-stealth behaviour. */
class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      let response: CdpResponse;
      try {
        response = JSON.parse(String(event.data)) as CdpResponse;
      } catch {
        return;
      }
      if (!response.id) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message ?? 'CDP command failed'));
      else pending.resolve(response.result ?? {});
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) item.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  static async connect(webSocketDebuggerUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('无法连接浏览器 CDP')); };
      const cleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
    return new CdpClient(socket);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('CDP connection is not open');
    const id = this.nextId++;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close(): void {
    this.socket.close();
  }
}

class CdpBossSession implements BossBrowserSession {
  public constructor(private readonly client: CdpClient, private readonly target: CdpTarget) {}

  async inspect(): Promise<BrowserPageState> {
    const snapshot = await this.evaluate<{ href: string; title: string; body: string }>(`(() => ({
      href: location.href,
      title: document.title,
      body: (document.body?.innerText ?? '').slice(0, 12000)
    }))()`);
    const body = snapshot.body.replace(/\s+/g, ' ');
    return {
      url: snapshot.href || this.target.url,
      title: snapshot.title || this.target.title,
      loginRequired: /扫码登录|立即登录|登录后|请登录/.test(body),
      verificationRequired: /安全验证|访问验证|验证码|操作频繁|403/.test(body),
      paywallVisible: /权益不足|购买权益|开通会员|直豆不足|额度不足|付费/.test(body),
    };
  }

  async findCandidates(locator: CandidateLocator): Promise<CandidateSnapshot[]> {
    const expectedName = JSON.stringify(locator.displayedName);
    return this.evaluate<CandidateSnapshot[]>(`(() => {
      const norm = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
      const expected = norm(${expectedName});
      const roots = Array.from(document.querySelectorAll('.candidate-card-wrap, .geek-info-card'));
      return roots.map((root) => {
        const displayedName = norm(root.querySelector('.name-wrap .name, .name-label, .name')?.textContent);
        const rawText = norm(root.textContent);
        const currentCompany = norm(root.querySelector('.company, .company-name, .work-experience')?.textContent);
        const currentTitle = norm(root.querySelector('.position, .job-title, .expect-wrap')?.textContent);
        return { displayedName, currentCompany, currentTitle, rawText };
      }).filter((candidate) => candidate.displayedName === expected);
    })()`);
  }

  async openCandidate(locator: CandidateLocator): Promise<void> {
    const point = await this.candidatePoint(locator, '.name-wrap .name, .name-label, .info-detail, .geek-info-main, a');
    if (!point) throw new Error('当前页面未找到可打开的候选人卡片');
    await this.click(point);
  }

  async assertActiveCandidate(locator: CandidateLocator): Promise<boolean> {
    const expectedName = JSON.stringify(locator.displayedName);
    const expectedCompany = JSON.stringify(locator.currentCompany ?? '');
    const expectedTitle = JSON.stringify(locator.currentTitle ?? '');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const matched = await this.evaluate<boolean>(`(() => {
        const norm = (value) => (value ?? '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
        const root = document.querySelector('.base-info-single-container');
        if (!(root instanceof HTMLElement)) return false;
        const text = norm(root.innerText);
        const has = (value) => !value || text.includes(norm(value));
        return has(${expectedName}) && has(${expectedCompany}) && has(${expectedTitle});
      })()`);
      if (matched) return true;
      await wait(250);
    }
    return false;
  }

  async readConversation(): Promise<string> {
    return this.evaluate<string>(`(() => (document.querySelector('.chat-message-list')?.innerText ?? '').trim())()`);
  }

  async stageMessage(message: string): Promise<void> {
    const value = JSON.stringify(message);
    const staged = await this.evaluate<boolean>(`(() => {
      const visible = (el) => el instanceof HTMLElement && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const list = document.querySelector('.chat-message-list');
      let scope = list?.parentElement ?? null;
      for (let i = 0; scope && i < 5; i += 1, scope = scope.parentElement) {
        const input = Array.from(scope.querySelectorAll('textarea, [contenteditable="true"]')).find(visible);
        if (!(input instanceof HTMLElement)) continue;
        input.focus();
        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) input.value = ${value};
        else input.textContent = ${value};
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })()`);
    if (!staged) throw new Error('当前页面未找到可见消息输入框');
  }

  async readStagedMessage(): Promise<string> {
    return this.evaluate<string>(`(() => {
      const visible = (el) => el instanceof HTMLElement && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const list = document.querySelector('.chat-message-list');
      let scope = list?.parentElement ?? null;
      for (let i = 0; scope && i < 5; i += 1, scope = scope.parentElement) {
        const input = Array.from(scope.querySelectorAll('textarea, [contenteditable="true"]')).find(visible);
        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) return input.value ?? '';
        if (input instanceof HTMLElement) return input.textContent ?? '';
      }
      return '';
    })()`);
  }

  async commitMessage(): Promise<void> {
    const point = await this.findConversationSendButtonPoint();
    if (!point) throw new Error('当前页面未找到可用的发送按钮');
    await this.click(point);
  }

  async commitGreeting(locator: CandidateLocator): Promise<void> {
    const point = await this.candidatePoint(locator, '.button-chat-wrap .btn.btn-greet');
    if (!point) throw new Error('当前页面未找到可用的打招呼按钮');
    await this.click(point);
  }

  async verifyMessageCommit(message: string): Promise<'confirmed' | 'not_confirmed' | 'uncertain'> {
    const expected = JSON.stringify(message.trim());
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await this.evaluate<{ input: string; conversation: string }>(`(() => {
        const visible = (el) => el instanceof HTMLElement && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const list = document.querySelector('.chat-message-list');
        let scope = list?.parentElement ?? null;
        let input = null;
        for (let i = 0; scope && i < 5; i += 1, scope = scope.parentElement) {
          input = Array.from(scope.querySelectorAll('textarea, [contenteditable="true"]')).find(visible);
          if (input) break;
        }
        const inputText = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input?.textContent;
        return { input: inputText ?? '', conversation: list?.innerText ?? '' };
      })()`);
      if (!state.input.trim() && state.conversation.includes(JSON.parse(expected) as string)) return 'confirmed';
      await wait(250);
    }
    return 'uncertain';
  }

  async verifyGreetingCommit(locator: CandidateLocator): Promise<'confirmed' | 'not_confirmed' | 'uncertain'> {
    const expectedName = JSON.stringify(locator.displayedName);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await this.evaluate<'confirmed' | 'not_confirmed'>(`(() => {
        const norm = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
        const card = Array.from(document.querySelectorAll('.candidate-card-wrap, .geek-info-card')).find((root) =>
          norm(root.querySelector('.name-wrap .name, .name-label, .name')?.textContent) === norm(${expectedName})
        );
        if (!card) return 'not_confirmed';
        const button = card.querySelector('.button-chat-wrap .btn.btn-greet');
        if (!(button instanceof HTMLElement)) return 'confirmed';
        const disabled = button.hasAttribute('disabled') || /disabled|forbid|ban/i.test(button.className);
        return disabled ? 'confirmed' : 'not_confirmed';
      })()`);
      if (result === 'confirmed') return result;
      await wait(250);
    }
    return 'uncertain';
  }

  async close(): Promise<void> {
    this.client.close();
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const response = await this.client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const exception = response.exceptionDetails as { text?: string } | undefined;
    if (exception) throw new Error(exception.text ?? '页面脚本执行失败');
    const result = response.result as { value?: T } | undefined;
    return result?.value as T;
  }

  private async candidatePoint(locator: CandidateLocator, preferredSelector: string): Promise<Point | null> {
    const expectedName = JSON.stringify(locator.displayedName);
    return this.evaluate<Point | null>(`(() => {
      const norm = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
      const expected = norm(${expectedName});
      const roots = Array.from(document.querySelectorAll('.candidate-card-wrap, .geek-info-card'));
      const matches = roots.filter((root) => norm(root.querySelector('.name-wrap .name, .name-label, .name')?.textContent) === expected);
      if (matches.length !== 1) return null;
      const element = matches[0].querySelector(${JSON.stringify(preferredSelector)});
      if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
  }

  private async findConversationSendButtonPoint(): Promise<Point | null> {
    return this.evaluate<Point | null>(`(() => {
      const norm = (value) => (value ?? '').replace(/\\s+/g, '').trim();
      const list = document.querySelector('.chat-message-list');
      let scope = list?.parentElement ?? null;
      for (let i = 0; scope && i < 5; i += 1, scope = scope.parentElement) {
        const button = Array.from(scope.querySelectorAll('button, .btn, [role="button"]')).find((element) => {
          if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && norm(element.textContent) === '发送';
        });
        if (!(button instanceof HTMLElement)) continue;
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return null;
    })()`);
  }

  private async click(point: Point): Promise<void> {
    await this.client.send('Page.bringToFront');
    await this.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
}

export class CdpBossBrowserFactory implements BossBrowserFactory {
  public constructor(
    private readonly port = Number.parseInt(process.env.BOSS_RPA_CDP_PORT ?? '53470', 10),
    private readonly targetId = process.env.BOSS_RPA_TARGET_ID?.trim(),
  ) {}

  async connect(): Promise<BossBrowserSession> {
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      throw new Error('BOSS_RPA_CDP_PORT 必须是有效端口');
    }
    const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('招聘专用浏览器未启动或未开启远程调试端口');
    const targets = await response.json() as CdpTarget[];
    const bossTargets = targets.filter((item) => item.type === 'page' && /^https:\/\/([^/]+\.)?zhipin\.com\//i.test(item.url) && item.webSocketDebuggerUrl);
    const target = this.targetId
      ? bossTargets.find((item) => item.id === this.targetId)
      : bossTargets.length === 1 ? bossTargets[0] : undefined;
    if (!this.targetId && bossTargets.length > 1) {
      throw new Error('检测到多个 BOSS 页面；请关闭无关页面或设置 BOSS_RPA_TARGET_ID 指定招聘页面');
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('未找到已打开的 BOSS 页面；请由 HR 在招聘专用浏览器中打开 BOSS');
    return new CdpBossSession(await CdpClient.connect(target.webSocketDebuggerUrl), target);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
