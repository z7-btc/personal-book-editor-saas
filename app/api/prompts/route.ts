import path from 'node:path';
import fsp from 'node:fs/promises';
import { loadSettings } from '@/lib/book-engine/config/settings.js';
import { loadPromptTemplate, templateVariables } from '@/lib/book-engine/llm/prompts.js';
import { ValidationError } from '@/lib/book-engine/util/errors.js';
import {
  assertSameOrigin,
  readJsonBody,
  withBookApi,
} from '@/lib/book-store/api-helpers';
import { projectRoot, userConfigDir } from '@/lib/book-store/storage';

type SettingsLike = {
  prompt?: { systemFile?: string; reviewFile?: string; memoryFile?: string };
} & Record<string, unknown>;

/**
 * GET /api/prompts?full=1&file=prompts/xxx.txt —— 我的提示词模板。
 *
 * 每个用户一份（在用户配置目录的 prompts/ 下，首次使用时从出厂模板播种），
 * 改自己的那份不影响别人。
 */
export async function GET(request: Request) {
  return withBookApi(request, async (userId) => {
    const url = new URL(request.url);
    const wantFull = url.searchParams.get('full') === '1';
    const only = url.searchParams.get('file');
    const settings = (await loadSettings(projectRoot())) as SettingsLike;
    const files = [
      settings.prompt?.systemFile || 'prompts/rewrite-system.txt',
      settings.prompt?.reviewFile || 'prompts/review-system.txt',
      settings.prompt?.memoryFile || 'prompts/memory-system.txt',
    ];
    const root = userConfigDir(userId);
    const out = [];
    for (const file of files) {
      if (only && only !== file) continue;
      const loaded = (await loadPromptTemplate(root, file)) as {
        template: string;
        source: string;
        warning?: string;
      };
      out.push({
        file,
        source: loaded.source,
        warning: loaded.warning || null,
        variables: templateVariables(loaded.template),
        preview: loaded.template.slice(0, 1200),
        content: wantFull ? loaded.template : undefined,
        length: loaded.template.length,
      });
    }
    return { prompts: out };
  });
}

/** PUT / POST /api/prompts —— 保存我的提示词模板（只允许 prompts/*.txt）。 */
export async function PUT(request: Request) {
  return writePrompt(request);
}

export async function POST(request: Request) {
  return writePrompt(request);
}

async function writePrompt(request: Request) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const body = await readJsonBody<{ file?: unknown; content?: unknown }>(request);
    const rel = String(body.file || '');
    if (!/^prompts\/[a-z0-9_-]+\.txt$/i.test(rel)) {
      throw new ValidationError('只允许写入 prompts/*.txt');
    }
    const target = path.join(userConfigDir(userId), rel);
    const content = String(body.content ?? '');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    return { ok: true, file: rel, length: content.length };
  });
}
