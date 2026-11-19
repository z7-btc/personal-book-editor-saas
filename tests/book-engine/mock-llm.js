/**
 * 假的 OpenAI-compatible 服务端，用于测试改写链路（不需要真实 API Key）。
 *
 * 行为可配置，用来模拟真实模型的坏毛病：
 *   - normal     ：正常改写（保留占位符，改变文字）
 *   - dropTags   ：丢掉占位符（脚注/链接消失）—— 应当被自动补回
 *   - summary    ：只输出一句话（摘要化）—— 应当被质量检查判 fail
 *   - numberLoss ：把数字都删掉 —— 应当被数字检查抓到
 *   - badJson    ：review / memory 返回非法 JSON
 *   - http500    ：一直返回 500 —— 测试重试
 *   - rateLimit  ：前 N 次 429，之后成功 —— 测试退避重试
 *   - renameEntity：把专有名词换掉 —— 应当被专名检查抓到
 */

import http from 'node:http';

/**
 * @param {{behavior?: string, rateLimitTimes?: number, latencyMs?: number}} [options]
 */
export function createMockLlmServer(options = {}) {
  let behavior = options.behavior || 'normal';
  let calls = 0;
  let explainCalls = 0;
  let rateLimitLeft = options.rateLimitTimes ?? 0;
  const latencyMs = options.latencyMs ?? 0;
  /** @type {Array<{messages: any[], body: any}>} */
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');

    if (req.url === '/__config') {
      const body = JSON.parse(raw || '{}');
      if (body.behavior) behavior = body.behavior;
      if (typeof body.rateLimitTimes === 'number') rateLimitLeft = body.rateLimitTimes;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, behavior, calls }));
      return;
    }
    if (req.url === '/__stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ calls, requests: requests.length, behavior }));
      return;
    }
    if (req.url === '/__reset') {
      calls = 0;
      requests.length = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    calls += 1;
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));

    if (rateLimitLeft > 0) {
      rateLimitLeft -= 1;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { message: 'rate limited (mock)' } }));
      return;
    }
    if (behavior === 'http500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom (mock)' } }));
      return;
    }
    if (behavior === 'networkError') {
      req.socket.destroy();
      return;
    }

    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad request' } }));
      return;
    }
    requests.push({ messages: body.messages, body });

    const userContent = body.messages?.find((m) => m.role === 'user')?.content || '';
    const systemContent = body.messages?.find((m) => m.role === 'system')?.content || '';
    const isReview = /审校员|Reviewer|"verdict"/.test(userContent) || /审校/.test(systemContent);
    /**
     * 记忆更新请求的识别必须精确。
     *
     * 早先只用了 /book_summary|记忆/，而改写 prompt 里也出现了「记忆」二字
     * （「形成可以长期记住的知识结构」之类），于是改写请求被误判成记忆请求、
     * 返回了一段 JSON，导致一整批改写测试失败。
     * 现在只认「当前记忆：」这个变量标签，以及记忆 prompt 独有的字段名。
     */
    const isMemory =
      systemContent.includes('维护「一本书的记忆」') ||
      userContent.includes('当前记忆：') ||
      /"important_concepts"/.test(systemContent);
    if (isMemory && /【段 \d+】/.test(userContent)) {
      // 双重保险：带段落标记的一律当改写处理
      throw new Error('mock: 请求同时像记忆和改写，无法判断');
    }
    /**
     * 压缩请求（digest）：把一整章压成一页提要。
     *
     * 认的是 digest-system.txt 里独有的措辞。**必须放在改写之前判断** ——
     * 提要 prompt 里没有 `【段 N】` 标记，落到改写分支只会得到
     * 「（mock）没有找到任何段落标记。」这种恰好非空、看起来"成功"的垃圾，
     * 测试就假装通过了。
     */
    const isDigest = /跳过一整章|压缩成\*\*一页提要\*\*/.test(systemContent);
    /**
     * 第二遍「补讲」请求：prompt 结尾是 ⟪正文结束⟫（改写那遍是 ⟪原文结束⟫）。
     * 默认行为返回「无需处理」，这样不开补讲行为的旧测试不受影响。
     */
    const isExplain = /读者补讲/.test(systemContent) || userContent.includes('⟪正文结束⟫');

    // 模拟「输出被 max_tokens 截断」：真实 API 会返回空 content + finish_reason=length
    if (behavior === 'finishLength') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model || 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 4000,
          total_tokens: 4100,
          completion_tokens_details: { reasoning_tokens: 4000 },
        },
      }));
      return;
    }

    // 模拟「推理模型先消耗思考额度」：
    // 无论 max_tokens 多大，都先烧掉 REASONING_COST，正文才可能输出。
    // 额度不足以覆盖思考时返回空 content + finish_reason=length（真实 API 的行为）。
    // reasoningModelCheap 表示思考开销较小的模型，用于验证"正常路径"。
    if (behavior === 'reasoningModel' || behavior === 'reasoningModelCheap') {
      const budget = Number(body.max_tokens || 0);
      const REASONING_COST = behavior === 'reasoningModelCheap' ? 64 : 1200;
      if (budget <= REASONING_COST) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model || 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
          usage: {
            prompt_tokens: 50,
            completion_tokens: budget,
            total_tokens: 50 + budget,
            completion_tokens_details: { reasoning_tokens: budget },
          },
        }));
        return;
      }
      // 额度够：思考 + 正常回答
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model || 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '可用' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 50,
          completion_tokens: REASONING_COST + 3,
          total_tokens: 53 + REASONING_COST,
          completion_tokens_details: { reasoning_tokens: REASONING_COST },
        },
      }));
      return;
    }

    // 模拟「老网关不认识 reasoning_effort」：带了就 400
    if (behavior === 'rejectsReasoningEffort' && 'reasoning_effort' in body) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: "Unrecognized request argument supplied: reasoning_effort", type: 'invalid_request_error' },
      }));
      return;
    }

    let text;
    if (isExplain) {
      explainCalls += 1;
      text = explainResponse(userContent, behavior, explainCalls);
    } else if (isDigest) {
      text = behavior === 'emptyDigest'
        ? ''
        : '（mock 提要）这一章是出版方与几位业内人士的推荐语，作者身份是交易所与基金公司高管。\n\n' +
          '（mock 提要）实质内容只有两点：一是价值投资需要一个一以贯之的分析框架，' +
          '二是本书提供了这套框架的完整示范。其余是赞誉之词，可以跳过。';
    } else if (isMemory) {
      text = behavior === 'badJson'
        ? '这不是 JSON'
        : JSON.stringify({
            book_summary: '（mock）这是一本用于测试的书。',
            important_concepts: ['安全边际'],
            people: ['Benjamin Graham'],
            terminology: [{ term: 'margin of safety', translation: '安全边际' }],
            author_positions: ['投资需要留有余地'],
            chapter_summaries: { '1': '（mock）第一章摘要' },
          });
    } else if (isReview) {
      text = behavior === 'badJson'
        ? 'not json at all'
        : JSON.stringify({
            score: behavior === 'strictReview' ? 60 : 95,
            verdict: behavior === 'strictReview' ? 'revise' : 'pass',
            issues: behavior === 'strictReview'
              ? [{ type: 'omission', severity: 'high', block: '【段 2】', detail: '（mock）遗漏了限定语', fix: '补回' }]
              : [],
            summary: '（mock）总体忠实',
          });
    } else {
      text = rewriteSource(userContent, behavior);
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }));
  });

  return {
    server,
    get calls() {
      return calls;
    },
    get requests() {
      return requests;
    },
    setBehavior(next) {
      behavior = next;
    },
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      const address = server.address();
      return {
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 按【段 N】结构生成改写结果。
 *
 * 注意：user message 是**整个模板**，`【段 N】` 只出现在 {{SOURCE_TEXT}} 展开之后。
 * 所以不能简单地「从段 1 标记一路取到段 2 标记」——那会把模板尾部的内容
 * 也算进段 1，导致输出里凭空多出整段原文。
 * 这里改成：先取最后一个 `【段 1】`（也就是真正的原文块起点），
 * 再按顺序切分，并把「下一段标记」和「模板尾部特征串」都当作终止边界。
 */
/**
 * 第二遍「补讲」的假回答。
 *
 *   - 默认         ：无需处理（旧测试不受影响）
 *   - explain      ：给前两段各插一句讲解（锚点取自原文）
 *   - explainBadMarks：锚点里带 ⟦n⟧ 标记 —— 段里找不到，必须被拒绝、保留原段
 *   - explainDrop  ：删掉一段 + 给第二段插一句
 *   - explainGarbageOnce / explainGarbageAlways：先回一段散文（解析不出条目），
 *                   用来验证「空结果要再问一次」和「两次都空要报警」
 */
function explainResponse(userContent, behavior, explainCall = 1) {
  /** 前 N 次故意给一段「我读了一遍，没什么要补的」的散文，验证代码会不会重问。 */
  if (behavior === 'explainGarbageOnce' || behavior === 'explainGarbageAlways') {
    const limit = behavior === 'explainGarbageOnce' ? 1 : Infinity;
    if (explainCall <= limit) return '我读了一遍这一章，写得挺清楚的，第一段不用解释，后面也还好。';
    behavior = 'explain';
  }
  if (behavior !== 'explain' && behavior !== 'explainBadMarks' && behavior !== 'explainDrop') {
    return '无需处理';
  }
  const text = String(userContent);
  const parts = [];
  const re = /【段\s*(\d+)】([\s\S]*?)(?=\n\n【段\s*\d+】|⟪正文结束⟫|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) parts.push({ n: Number(m[1]), body: m[2] });
  if (!parts.length) return '无需处理';

  /** 取第一个分句（锚点止于标点前，正好能被插在标点之后）。 */
  const anchorOf = (body) => {
    const plain = body.replace(/⟦[^⟧]*⟧/g, '').trim();
    const m = plain.match(/^(.{2,20}?)[，。；：]/);
    return m ? m[1] : [...plain].slice(0, 8).join('');
  };

  const out = [];
  if (behavior === 'explainDrop' && parts.length >= 5) {
    // 第 4 段：不碰首末段、足够长且无标记，可以删
    out.push('【删 4】（mock）重复的客套话，没有任何信息量');
  }
  const withMarks = parts.find((p) => /⟦/.test(p.body));
  const targets = behavior === 'explainDrop'
    ? [parts[1]]
    : behavior === 'explainBadMarks'
      ? (withMarks ? [withMarks] : [])
      : parts.slice(0, 2);
  for (const part of targets) {
    if (behavior === 'explainBadMarks') {
      // 锚点带上标记 —— 落在 DOM 文字里找不到，安全线必须拒绝这一条
      const marked = part.body.match(/⟦[^⟧]*⟧[^⟦]*⟦\/[^⟧]*⟧/)?.[0] || part.body.slice(0, 8);
      out.push(`【补 ${part.n}】「${marked}」→（mock 补讲：这里提到的旧事物，当时的背景是这样的。）`);
      continue;
    }
    const anchor = anchorOf(part.body);
    out.push(`【补 ${part.n}】「${anchor}」→（mock 补讲：这里提到的旧事物，当时的背景是这样的。）`);
  }
  return out.join('\n\n');
}

function rewriteSource(userContent, behavior) {  const text = String(userContent);
  const markerRe = /【段\s*(\d+)】/g;

  // 找出所有「从 1 开始递增」的连续标记序列，最后一段序列就是真正的原文
  const all = [];
  let m;
  while ((m = markerRe.exec(text)) !== null) {
    all.push({ n: Number(m[1]), start: m.index, contentStart: m.index + m[0].length });
  }
  if (!all.length) return '（mock）没有找到任何段落标记。';

  let seqStart = 0;
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].n === 1) seqStart = i;
  }
  const seq = [];
  for (let i = seqStart; i < all.length; i += 1) {
    if (i > seqStart && all[i].n !== all[i - 1].n + 1) break;
    seq.push(all[i]);
  }
  if (!seq.length) return '（mock）没有找到任何段落标记。';

  // 原文块的结束位置：最后一段之后，遇到结束标记或模板尾部特征串就截断
  const TAIL_MARKERS = ['⟪原文结束⟫', '\n输出要求', '输出要求：', '\n只返回处理后的正文'];
  let blockEnd = text.length;
  for (const marker of TAIL_MARKERS) {
    const idx = text.indexOf(marker, seq[seq.length - 1].contentStart);
    if (idx >= 0 && idx < blockEnd) blockEnd = idx;
  }

  const parts = [];
  for (let i = 0; i < seq.length; i += 1) {
    const cur = seq[i];
    const end = i + 1 < seq.length ? seq[i + 1].start : blockEnd;
    const source = text.slice(cur.contentStart, end).trim();
    parts.push(`【段 ${cur.n}】${transformSegment(source, behavior)}`);
  }
  return parts.join('\n\n');
}

/**
 * 模拟「模型改写文字时把占位符搞坏了」。
 *
 * 关键点：必须把占位符先摘出来，只改普通文字，再放回去。
 * 否则正则会把 `⟦12⟧` 里的数字也当成正文数字替换掉，
 * 产生 `⟦若干⟧` 这种畸形标记 —— 那是「模型乱写标记」而不是我们要模拟的场景。
 */
function transformTextOutsidePlaceholders(source, fn) {
  const parts = String(source).split(/(⟦\/?\d+⟧)/);
  return parts.map((part) => (/^⟦\/?\d+⟧$/.test(part) ? part : fn(part))).join('');
}

function transformSegment(source, behavior) {
  switch (behavior) {
    case 'dropTags':
      // 模拟模型丢掉所有占位符（脚注/链接消失）
      return transformTextOutsidePlaceholders(source, (t) => t).replace(/⟦\/?\d+⟧/g, '');
    case 'summary':
      // 模拟「过度总结」：把整段压成一句结论
      return '这一段就是说投资要注意风险，别的都是细节，记住结论就可以了。';
    case 'templateLeadIn':
      /**
       * 模拟用户实际遇到的失败：模型给**每个自然段**都贴上一句
       * 「这一节的核心结论是：」，一章 16k 字里出现 20 次，
       * 连着 8 段每段一次，读起来「一段一段的」。
       *
       * 这个行为专门用来验证文风守卫（style-guard.js）真的在链路上生效：
       * 提示词层面的禁止只是概率性的，机械兜底必须在成品里把它们清干净。
       */
      return `这一节的核心结论是：${transformTextOutsidePlaceholders(source, (t) => t)}`;
    case 'numberLoss':
      // 只改正文里的数字，保留占位符（这是"数字被改掉但结构没坏"的真实场景）
      return transformTextOutsidePlaceholders(source, (t) => t.replace(/\d+(?:\.\d+)?/g, '若干'));
    case 'renameEntity':
      // 只改正文里的专名，保留占位符
      return transformTextOutsidePlaceholders(source, (t) =>
        t
          .replace(/Benjamin Graham|Mr\. Graham|Graham/g, '某位学者')
          .replace(/David Dodd/g, '他的同事')
          .replace(/Acme Corp\./g, '一家公司')
          .replace(/Beta Industries/g, '另一家公司')
          .replace(/Gamma Holdings/g, '第三家公司'),
      );
    case 'empty':
      return '';
    case 'noMarkers':
      return `（没有标记的裸文本）${source}`;
    case 'longer':
      return `${source}（补充说明：这里是为了测试长度上限而刻意加长的内容，重复若干次。重复若干次。重复若干次。）`;
    default:
      // 正常：保留占位符，改写措辞（去口水话）
      return transformTextOutsidePlaceholders(source, (t) =>
        t
          .replace(/值得注意的是，/g, '')
          .replace(/不过他也承认，/g, '他也承认，')
          .replace(/这句话后来被引用了无数次。/, '这句话后来被反复引用。')
          .replace(/另一些人（例如/, '另有一些人（例如'),
      );
  }
}

/** 造一个最小的 OpenAI-compatible 响应体（供其它测试复用）。 */
export function mockChatResponse(text) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
