import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAgentArtifact, type AgentArtifact } from '@/lib/code-space/agent/artifacts';

export interface BrowserSessionSnapshot {
  sessionId: string;
  url: string;
  title: string;
  consoleMessages: string[];
  networkErrors: string[];
  screenshotArtifact?: AgentArtifact;
}

interface BrowserSession {
  id: string;
  browser: import('@playwright/test').Browser;
  page: import('@playwright/test').Page;
  consoleMessages: string[];
  networkErrors: string[];
  createdAt: number;
  lastActiveAt: number;
}

export class BrowserController {
  private readonly sessions = new Map<string, BrowserSession>();

  async open(input: { root: string; runId: string; url: string; viewport?: { width: number; height: number } }): Promise<BrowserSessionSnapshot> {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: input.viewport ?? { width: 1440, height: 1000 },
    });
    const id = `browser:${input.runId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
    const session: BrowserSession = {
      id,
      browser,
      page,
      consoleMessages: [],
      networkErrors: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    page.on('console', (message) => {
      session.consoleMessages.push(`[${message.type()}] ${message.text()}`);
      session.lastActiveAt = Date.now();
    });
    page.on('requestfailed', (request) => {
      session.networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`);
      session.lastActiveAt = Date.now();
    });
    this.sessions.set(id, session);
    await page.goto(input.url, { waitUntil: 'networkidle', timeout: 30_000 });
    return this.snapshot(input.root, input.runId, id, true);
  }

  async click(sessionId: string, selector: string): Promise<BrowserSessionSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    await session.page.click(selector, { timeout: 10_000 });
    session.lastActiveAt = Date.now();
    return this.snapshot('', '', sessionId, false);
  }

  async type(sessionId: string, selector: string, text: string): Promise<BrowserSessionSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    await session.page.fill(selector, text, { timeout: 10_000 });
    session.lastActiveAt = Date.now();
    return this.snapshot('', '', sessionId, false);
  }

  async scroll(sessionId: string, x = 0, y = 600): Promise<BrowserSessionSnapshot | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    await session.page.mouse.wheel(x, y);
    session.lastActiveAt = Date.now();
    return this.snapshot('', '', sessionId, false);
  }

  async eval(sessionId: string, expression: string): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const value = await session.page.evaluate((source) => {
      // Browser QA runs model-authored snippets in the page context; stringify the bounded result.
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return (${source});`)();
    }, expression);
    session.lastActiveAt = Date.now();
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  async screenshot(root: string, runId: string, sessionId: string, label = 'screenshot'): Promise<BrowserSessionSnapshot | null> {
    return this.snapshot(root, runId, sessionId, true, label);
  }

  console(sessionId: string): { consoleMessages: string[]; networkErrors: string[] } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { consoleMessages: [...session.consoleMessages], networkErrors: [...session.networkErrors] };
  }

  async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await session.browser.close().catch(() => undefined);
    this.sessions.delete(sessionId);
    return true;
  }

  private async snapshot(root: string, runId: string, sessionId: string, capture: boolean, label = 'initial'): Promise<BrowserSessionSnapshot> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown browser session: ${sessionId}`);
    session.lastActiveAt = Date.now();
    let screenshotArtifact: AgentArtifact | undefined;
    if (capture && root && runId) {
      const png = await session.page.screenshot({ fullPage: true, type: 'png' });
      const dir = path.join(root, '.agent', 'artifacts', runId, 'browser');
      await fs.mkdir(dir, { recursive: true });
      const screenshotPath = path.join(dir, `${safeLabel(label)}-${Date.now()}.png`);
      await fs.writeFile(screenshotPath, png);
      screenshotArtifact = await writeAgentArtifact({
        projectRoot: root,
        runId,
        kind: 'browser_screenshot',
        content: screenshotPath,
        summary: `Browser screenshot: ${await session.page.title()} ${session.page.url()}`,
      });
    }
    return {
      sessionId,
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
      consoleMessages: [...session.consoleMessages],
      networkErrors: [...session.networkErrors],
      screenshotArtifact,
    };
  }
}

function safeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'screenshot';
}
