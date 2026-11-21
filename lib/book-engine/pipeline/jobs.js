/**
 * 任务管理：Rewrite All / Rewrite Selected / Retry Failed 的调度与暂停恢复。
 *
 * 设计原则（需求第二 / 十三 / 十九节）：
 *  - 单进程、单机、内存里保存「运行时状态」，磁盘上保存「可恢复状态」；
 *  - Pause 只是 abort 当前请求，已完成的 chunk 已经落盘，Resume 会跳过它们；
 *  - 程序重启后 running 状态一律视为「未完成」，重新跑即可，不会重复计费的部分
 *    只有「当前正在飞行的那一个 chunk」。
 */

import { AbortedError } from '../util/errors.js';
import * as ws from './workspace.js';
import { extractChapter, exportBook, analyzeBookInboundLinks, buildBookNoteRefs } from './book-service.js';
import { rewriteChapter } from './rewrite.js';
import { buildChapterImageNotes } from './image-notes.js';
import { buildDigest, applyDigest } from './digest.js';
import { readUntouchedChapters } from './plan-untouched.js';
import { digestRisk } from '../epub/inbound-links.js';
import { parseXml, bodyTextLength } from '../epub/xml-dom.js';
import { loadPromptTemplate } from '../llm/prompts.js';
import { updateBookMemory as updateMemoryViaLlm } from './rewrite.js';

/** @typedef {'rewrite'|'export'|'extract'} JobKind */

let jobSeq = 0;

export class JobManager {
  constructor({ getContext }) {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** 取运行上下文（provider / settings / profile）的回调 */
    this.getContext = getContext;
  }

  list() {
    return [...this.jobs.values()].map(publicJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : null;
  }

  /** 某本书是否有正在跑的任务。 */
  activeForBook(bookId) {
    return [...this.jobs.values()].some(
      (j) => j.bookId === bookId && (j.status === 'running' || j.status === 'pausing'),
    );
  }

  /**
   * 启动一个改写任务。
   * @param {Object} args
   * @param {string} args.bookId
   * @param {number[]} args.chapters
   * @param {'rewrite'|'export'} [args.kind]
   */
  /**
   * @param {Object} args
   * @param {string} args.bookId
   * @param {number[]} args.chapters
   * @param {'rewrite'|'export'} [args.kind]
   * @param {string} [args.mode]
   * @param {boolean} [args.resume]
   *        是否是「接着上次跑」。为 true 时会复用章节里已保存的
   *        chunk 结果，中断处继续；为 false（例如用户点「重新改写」）
   *        则整章重做。
   */
  start({ bookId, chapters, kind = 'rewrite', mode = 'rewrite', resume = false }) {
    if (this.activeForBook(bookId)) {
      const err = new Error('这本书已有任务在运行中');
      err.status = 409;
      err.expose = true;
      throw err;
    }
    jobSeq += 1;
    const job = {
      id: `job_${Date.now().toString(36)}_${jobSeq}`,
      kind,
      mode,
      bookId,
      chapters: (chapters || []).slice().sort((a, b) => a - b),
      status: 'running',
      resumeFromChunkData: Boolean(resume),
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      finishedAt: null,
      currentChapter: null,
      completed: [],
      failed: [],
      skipped: [],
      message: '',
      error: null,
      controller: new AbortController(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      log: [],
      result: null,
    };
    this.jobs.set(job.id, job);
    job.promise = this._run(job).catch((err) => {
      job.status = 'failed';
      job.error = err?.expose ? err.message : String(err?.message || err);
      job.finishedAt = Date.now();
    });
    return publicJob(job);
  }

  /**
   * 启动「一键整理」：整理方案 → 逐章改写 → 导出，一条龙。
   *
   * 为什么不拆成三个任务让前端串起来：那样用户一关页面链路就断了，
   * 而且中间任何一步失败都不会有人接着做。做成一个任务，
   * 它自己活在后端，进度落在任务坞里，守夜进程也能兜住。
   */
  startAuto({ bookId }) {
    return this.start({ bookId, chapters: [], kind: 'auto', mode: 'auto' });
  }

  /**
   * 启动一次「整理方案」任务：让模型读完整本书，产出 book-plan.json。
   *
   * 这是用户问「以后上传任意一本书都会自动处理吗」时缺的那一环 ——
   * 删哪些章、压哪些章、每章叫什么、按什么顺序读，都得先有人把整本书
   * 读一遍才能决定。原先这段逻辑只活在 `scripts/plan-book.mjs` 里，
   * 没有 API、没有界面，所以在网页上根本走不到。
   */
  startPlan({ bookId }) {
    return this.start({ bookId, chapters: [], kind: 'plan', mode: 'plan' });
  }

  pause(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'running') {
      job.status = 'pausing';
      job.message = '正在暂停…（等待当前请求结束）';
      job.controller.abort(new AbortedError('用户暂停'));
    }
    return publicJob(job);
  }

  /**
   * 记录「这本书还有活没干完」。
   *
   * 任务本身只活在内存里，用户点暂停、刷新页面之后任务坞就消失了，
   * 再也找不到从哪接着做 —— 用户的原话是
   * 「刷新一下，左下角弹窗就不见了，也没办法点击继续生成了」。
   *
   * 这份记录写到磁盘：界面每次打开书籍页都能读到，
   * 于是「继续处理」这个入口永远找得到。
   */
  async _recordPendingWork(job, reason) {
    try {
      const metadata = await ws.readBookMetadata(job.bookId);
      const remaining = [];
      const partial = [];
      /**
       * 方案要求原样保留/删除的章节不算「还有活没干完」。
       * 口径必须和 `countRemaining()` 一致，否则任务坞会永远显示
       * 「还剩 1 章」—— 用户一点就改写掉方案不许动的章节。
       */
      const untouched = await readUntouchedChapters(job.bookId);
      for (const chapter of metadata.chapters || []) {
        if (chapter.rewritable === false) continue;
        if (untouched.has(chapter.index)) continue;
        const status = await ws.readChapterStatus(job.bookId, chapter.index);
        if ((status?.stage || 'pending') === 'completed') continue;
        remaining.push(chapter.index);
        /**
         * 只有**真的存下了模型输出**才算「做了 part」。
         *
         * chunkDone > 0 但 chunkResults 缺失，是更早版本留下的状态
         * （那时 onChunkDone 只存计数、不存内容）。
         * 这种情况下恢复只能整章重跑，界面上若还写着
         * 「会复用已完成的内容，不重复花钱」就是骗人 ——
         * 判断口径必须和 countRemaining() 一致。
         */
        if (status?.chunkDone > 0 && status?.chunkResults) partial.push(chapter.index);
      }
      if (remaining.length === 0) {
        await ws.clearPendingWork(job.bookId);
        return;
      }
      await ws.writePendingWork(job.bookId, {
        reason,
        mode: job.mode,
        remainingChapters: remaining,
        remaining: remaining.length,
        doneChapters: job.completed.slice(),
        failedChapters: job.failed.slice(),
        partialChapters: partial,
        lastJobId: job.id,
      });
    } catch {
      // 记录失败不影响主流程
    }
  }

  /** 因为程序重启而残留的 running 任务，允许用户强制标记取消。 */
  cancel(jobId) {
    return this.pause(jobId);
  }

  /**
   * 暂停 / 出错之后，把停在「处理中」的章节收回「已暂停」。
   *
   * 任务被 abort 时，正在写的那一章没有 finally 帮它收尾，状态就停在
   * `processing`。不收拾的后果不是「显示不好看」：那一行永远转着
   * 「处理中」，用户会一直以为它还在跑，不敢关页面、不敢做别的。
   *
   * 实测过：14:15 点暂停，到第二天 01:22 第 1 章还挂着 processing ——
   * 只有重启进程时 `reconcileInterruptedBooks()` 才会扫到它。
   * 用户只是按了一下暂停，不该等一次重启才恢复。
   */
  async _settleInterruptedChapters(job) {
    const chapters = Array.isArray(job?.chapters) ? job.chapters : [];
    // 为什么在这里分两种说法：用户点暂停和任务自己出错中断，是两件事。
    // 都写成「任务暂停」会让用户以为是自己的操作；而 chunkDone 为 0 时
    // 根本没有可接着用的段落，那句「已保存的段落下次接着用」是在许诺
    // 不存在的东西（第一个分块只写了一半时，确实没存下完整段落）。
    // 默认按「出错中断」判：只有明确是 paused 才算用户暂停，
    // 这样将来多出别的收尾状态也不会被错认成暂停。
    const why = job?.status === 'paused' ? '任务暂停' : '任务出错中断';
    for (const index of chapters) {
      try {
        const status = await ws.readChapterStatus(job.bookId, index);
        if (status?.stage !== 'processing') continue;
        const saved = (status.chunkDone || 0) > 0;
        await ws.writeChapterStatus(job.bookId, index, {
          ...status,
          stage: 'paused',
          note: saved
            ? `${why}，这一章还没写完（已保存的段落下次接着用）`
            : `${why}，这一章被打断了，还没有可接着用的段落`,
        });
      } catch {
        // 收尾失败不能影响主流程
      }
    }
  }

  async _run(job) {
    const { bookId, chapters } = job;
    job.log.push(job.kind === 'plan' ? '开始读整本书、生成整理方案' : `开始处理 ${chapters.length} 章`);
    try {
      if (job.kind === 'plan') {
        await this._planBook(job);
        job.status = job.controller.signal.aborted ? 'paused' : 'completed';
        job.finishedAt = Date.now();
        return;
      }
      if (job.kind === 'auto') {
        await this._autoBook(job);
        job.status = job.controller.signal.aborted ? 'paused' : job.failed.length ? 'completed_with_errors' : 'completed';
        job.finishedAt = Date.now();
        return;
      }
      for (const index of chapters) {
        if (job.controller.signal.aborted) throw new AbortedError();
        job.currentChapter = index;
        const outcome = await this._rewriteOne(job, index);
        if (outcome === 'completed') job.completed.push(index);
        else if (outcome === 'skipped') job.skipped.push(index);
        else job.failed.push(index);
        job.message = `已完成 ${job.completed.length}/${chapters.length}（失败 ${job.failed.length}）`;
      }
      job.status = job.controller.signal.aborted ? 'paused' : job.failed.length ? 'completed_with_errors' : 'completed';
    } catch (err) {
      if (err instanceof AbortedError || job.controller.signal.aborted) {
        job.status = 'paused';
        job.message = `已暂停：完成 ${job.completed.length}/${chapters.length}，可随时 Resume`;
      } else {
        job.status = 'failed';
        job.error = err?.expose ? err.message : String(err?.message || err);
        job.message = job.error;
      }
    } finally {
      job.finishedAt = Date.now();
      job.currentChapter = null;
      // 任务收尾时更新「还有多少没做完」。
      // 暂停 / 中断 / 部分失败都要留下记录，界面上才有「继续处理」的入口；
      // 全部做完了则清掉，免得一直提示。
      const reason =
        job.status === 'paused'
          ? '用户暂停'
          : job.status === 'completed_with_errors'
            ? '有章节失败'
            : job.status === 'failed'
              ? '任务出错中断'
              : '全部完成';
      // 停下来之后，还写着「处理中」的章节其实已经不会有人接着写了
      await this._settleInterruptedChapters(job);
      await this._recordPendingWork(job, reason);
    }
  }

  /**
   * 一键整理：整理方案 → 逐章改写 → 导出。
   *
   * 三步串在一个任务里，用户只要点一次；中途关页面、刷新、重启都不影响它。
   *
   * 改写哪几章由**方案**决定：
   *   · `skip`（原样保留）不碰 —— 改了也白改，导出时用的还是原文；
   *   · `drop`（整章删除）不碰 —— 它根本不会出现在成品里，改写纯属浪费钱；
   *   · `digest`（压缩成提要）照样进队列，`_rewriteOne` 会把它路由到压缩路径。
   *
   * 这三条是**省钱**的：用户那本书按方案只有 13 章需要完整改写，
   * 无脑全跑会多花一倍以上的调用。
   */
  async _autoBook(job) {
    const { bookId } = job;

    /* ---- 第一步：整理方案 ---- */
    job.log.push('【第 1/3 步】读完整本书，生成整理方案');
    job.message = '第 1/3 步 · 生成整理方案…';
    await this._planBook(job);
    if (job.controller.signal.aborted) return;

    const plan = await ws.readBookPlan(bookId);
    const metadata = await ws.readBookMetadata(bookId);
    const untouched = new Set(
      (plan?.entries || [])
        .filter((e) => e.strategy === 'skip' || e.strategy === 'drop')
        .map((e) => e.index),
    );
    const targets = (metadata.chapters || [])
      .filter((c) => c.rewritable !== false && !untouched.has(c.index))
      .map((c) => c.index);
    job.chapters = targets;

    if (!targets.length) {
      job.log.push('方案里没有需要改写的章节，直接导出');
    } else {
      /* ---- 第二步：逐章改写（脚注就地化在这一步发生）---- */
      job.log.push(
        `【第 2/3 步】改写 ${targets.length} 章（原样保留 ${untouched.size} 章不动：` +
          `改了也白改，导出的还是原文）`,
      );
      for (const index of targets) {
        if (job.controller.signal.aborted) return;
        job.currentChapter = index;
        job.message = `第 2/3 步 · 改写第 ${index} 章（已完成 ${job.completed.length}/${targets.length}）`;
        const outcome = await this._rewriteOne(job, index);
        if (outcome === 'completed') job.completed.push(index);
        else if (outcome === 'skipped') job.skipped.push(index);
        else job.failed.push(index);
      }
    }
    if (job.controller.signal.aborted) return;

    /* ---- 第三步：导出 ---- */
    job.log.push('【第 3/3 步】重新打包 EPUB');
    job.message = '第 3/3 步 · 导出…';
    const done = [];
    for (const chapter of metadata.chapters || []) {
      const status = await ws.readChapterStatus(bookId, chapter.index);
      if (status?.stage === 'completed') done.push(chapter.index);
    }
    const exported = await exportBook({ bookId, chapters: done });
    job.result = {
      ...(job.result || {}),
      export: {
        fileName: exported.fileName,
        size: exported.size,
        replacedCount: exported.replacedCount,
        addedCount: exported.addedCount,
        droppedChapters: exported.droppedChapters || [],
      },
    };
    job.log.push(
      `成品已生成：${exported.fileName}` +
        `（替换 ${exported.replacedCount} 个文件，删除 ${(exported.droppedChapters || []).length} 章）`,
    );
  }

  /**
   * 整理方案任务：跑三级流水线，把结果写进 book-plan.json。
   *
   * 进度通过 `onProgress` 打点到 job.log —— 卡片阶段有几十次调用，
   * 界面上必须能看见「判断到第几章了」，否则用户只会觉得卡住了。
   */
  async _planBook(job) {
    const { provider, projectRoot } = await this.getContext(job.bookId);
    const { planBook } = await import('./plan-service.js');

    const result = await planBook({
      bookId: job.bookId,
      provider,
      projectRoot,
      signal: job.controller.signal,
      onProgress: (info) => {
        job.message = info.message || '';
        if (info.phase === 'cards') {
          if (info.total) job.currentChapter = info.done;
          job.log.push(info.message);
        } else if (info.message) {
          job.log.push(info.message);
        }
      },
    });

    addUsage(job.usage, result.usage);
    job.result = {
      counts: result.plan.counts,
      values: result.plan.values,
      totalChars: result.plan.totalChars,
      digestRatio: result.plan.digestRatio,
      warnings: result.plan.warnings || [],
      named: result.stats.named,
    };
    job.log.push(
      `方案已写入：精读 ${result.plan.counts.keep || 0} 章 · ` +
        `压缩 ${result.plan.counts.digest || 0} 章 · ` +
        `原样保留 ${result.plan.counts.skip || 0} 章 · ` +
        `删除 ${result.plan.counts.drop || 0} 章；改名 ${result.stats.named} 章`,
    );
    if (result.plan.digestRatio > 0.25) {
      job.log.push(`⚠ 压缩比例 ${(result.plan.digestRatio * 100).toFixed(1)}%，超出 25% 的警戒线，建议复核`);
    }
  }

  async _rewriteOne(job, index) {
    const { provider, reviewProvider, imageProvider, settings, profile, projectRoot, bookContext } = await this.getContext(job.bookId);
    const status = (await ws.readChapterStatus(job.bookId, index)) || null;

    /**
     * 先判断这一页有没有可改写的正文。
     *
     * 整页插图 / 扫码提示页的正文里一个字都没有（或只有几个空白字符）。
     * 这类页面**绝对不能进改写流程**：
     *  - 模型面对空内容只会返回空，然后被质量检查判为「长度严重异常」；
     *  - 于是界面上出现一个「失败」的章节，而它其实本来就没有文字可改。
     * 这个 bug 真实发生过：第 9 章（「证券分析（上）」，整页插图）
     * 被标成 failed，错误信息是「原文 4 字，改写后仅 0 字」。
     *
     * 修法：在读元数据时就短路，连 extractChapter 都不调用，
     * 也不产生任何 API 请求，直接落一个 skipped 状态并说明原因。
     */
    const metadata = await ws.readBookMetadata(job.bookId);
    const chapterMeta = (metadata.chapters || []).find((c) => c.index === index);
    if (chapterMeta && chapterMeta.rewritable === false) {
      const reason =
        chapterMeta.kind === 'image-only'
          ? '这一页正文是整页图片，没有可改写的文字'
          : chapterMeta.kind === 'prompt'
            ? '这一页是扫码／关注之类的图片提示，不是书的内容'
            : '这一页没有正文内容';
      await ws.writeChapterStatus(job.bookId, index, {
        ...(status || ws.blankChapterStatus({ index, title: chapterMeta.title, href: chapterMeta.href })),
        title: chapterMeta.title,
        href: chapterMeta.href,
        stage: 'skipped',
        kind: chapterMeta.kind,
        chunkTotal: 0,
        chunkDone: 0,
        quality: null,
        error: null,
        note: `${reason}（导出时会原样保留）`,
      });
      job.log.push(`第 ${index} 章「${chapterMeta.title}」：${reason}，已跳过（不消耗 API）`);
      return 'skipped';
    }

    /**
     * 规划里标了 `digest` 的章节走**压缩**，不走逐段改写。
     *
     * 这一步不做的话会有一个很难发现的坑：那 8 章前置内容本来就该
     * 压成一页提要，但「Rewrite All」只认「哪些章没做完」，
     * 于是会把它们**整章重写一遍** —— 用户花两次钱，而且第二次
     * 把压缩结果整个盖掉，导出的书里那些提要又变回全文，
     * 目录名却还写着「已压缩为一页提要」。说的和做的对不上。
     */
    const planEntry = await this._planEntryFor(job, index);
    if (planEntry?.strategy === 'digest') {
      return this._digestOne(job, index, planEntry, { status, metadata });
    }

    // 1) 确保已提取
    const extraction = await extractChapter(job.bookId, index, {
      targetCharsPerChunk: settings.processing?.targetCharsPerChunk,
      maxCharsPerChunk: settings.processing?.maxCharsPerChunk,
    });
    const originalXhtml = await ws.readChapterOriginal(job.bookId, index);

    // 提取后仍然没有任何分块 => 同样没有可改写的正文，直接跳过
    if (!extraction.chunks.length) {
      const reason = '这一页没有可改写的正文内容';
      await ws.writeChapterStatus(job.bookId, index, {
        ...(status || ws.blankChapterStatus({ index, title: extraction.status.title, href: extraction.status.href })),
        title: extraction.status.title,
        href: extraction.status.href,
        stage: 'skipped',
        kind: extraction.status.kind || 'empty',
        chunkTotal: 0,
        chunkDone: 0,
        images: {
          total: extraction.status.imageCount || 0,
          preservedCaptionBlocks: extraction.status.preservedCaptionBlocks || 0,
          preservedImageBlocks: extraction.status.preservedImageBlocks || 0,
          described: 0,
        },
        quality: null,
        error: null,
        note: `${reason}（导出时会原样保留）`,
      });
      job.log.push(`第 ${index} 章「${extraction.status.title}」：${reason}，已跳过`);
      return 'skipped';
    }

    const baseStatus = {
      ...(status || ws.blankChapterStatus({ index, title: extraction.status.title, href: extraction.status.href })),
      title: extraction.status.title,
      href: extraction.status.href,
      stage: 'processing',
      chunkTotal: extraction.chunks.length || extraction.status.chunkTotal,
      chunkDone: 0,
      error: null,
      attempts: (status?.attempts || 0) + 1,
    };
    await ws.writeChapterStatus(job.bookId, index, baseStatus);

    /**
     * 中断恢复：把上次已完成的 chunk 结果捞回来。
     *
     * 只在「这次是恢复而不是重做」时用：
     *  - 上次是被暂停 / 崩溃打断的（stage 是 processing 或 paused）
     *  - 或者用户明确要求续跑
     * 如果章节已经 completed、而用户点了「重新改写」，那是一定要重做的，
     * 这时不能复用旧结果。判断交给调用方通过 resume 标记控制。
     */
    const resumeChunkResults =
      job.resumeFromChunkData && status?.chunkResults ? status.chunkResults : {};

    const memory = settings.memory?.enabled ? await ws.readBookMemory(job.bookId) : null;

    /**
     * 脚注就地化：把这一章引用到的注释正文展开到原文里，
     * 模型在原位就能看到「这里原本有一条脚注，内容是……」，
     * 由它决定融进句子还是丢掉（见 rewrite-system.txt 的脚注一节）。
     */
    const noteRefs = await this._noteRefsFor(job);

    /**
     * 图片说明：改写之前先让模型「看懂」这一章的图。
     *
     * 没有这一步，模型只看到 `⟦n⟧` 这个占位符，不知道那里是张什么图，
     * 改写正文时就会把「见表 6-1」这类指代改丢，或者把图片挪到别的段落。
     * 说明会拼进提示词（IMAGE_NOTES），而**图注块本身不参与改写**。
     *
     * 这一步失败只记一条日志：图片说明是「帮模型看懂」，
     * 不该因为它把整章改写拦住 —— 最坏也只是退回只看图注。
     */
    let chapterImages = [];
    let imageStats = null;
    try {
      const notes = await buildChapterImageNotes({
        bookId: job.bookId,
        chapterHref: baseStatus.href || chapterMeta?.href || '',
        xhtml: originalXhtml,
        provider: imageProvider || provider,
        settings,
        signal: job.controller.signal,
        onProgress: (info) => {
          job.message = `第 ${index} 章 · 识别图片 ${info.image}/${info.total}`;
        },
      });
      chapterImages = notes.images;
      imageStats = notes.stats;
      if (imageStats.total) {
        job.log.push(
          `第 ${index} 章 · 图片 ${imageStats.total} 张：本次识别 ${imageStats.described}，` +
            `缓存复用 ${imageStats.fromCache}，图注兜底 ${imageStats.captionFallback}，失败 ${imageStats.failed}`,
        );
      }
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      job.log.push(`第 ${index} 章 · 图片说明没生成成功（不影响改写）：${err.message}`);
    }

    const result = await rewriteChapter({
      xhtml: originalXhtml,
      provider,
      providerForReview: reviewProvider,
      profile,
      settings,
      projectRoot,
      bookContext,
      bookMemory: memory,
      chapterTitle: baseStatus.title,
      chapterHref: baseStatus.href,
      chapterImages,
      signal: job.controller.signal,
      resumeChunkResults,
      noteRefs,
      onProgress: (info) => {
        job.message = `第 ${index} 章 · ${describeProgress(info)}`;
      },
      onChunkDone: async (info) => {
        // 立即落盘：刷新页面 / 崩溃都不丢
        await ws.saveChapterRewritten(job.bookId, index, info.doc.serialize());
        baseStatus.chunkDone = info.chunkIndex + 1;
        baseStatus.usage = info.usage;
        // 关键：把每个已完成 chunk 的模型输出也存下来。
        // 只存计数是不够的 —— 恢复时会找不到内容，只能整章重跑。
        baseStatus.chunkResults = info.chunkResults;
        await ws.writeChapterStatus(job.bookId, index, baseStatus);
        const tag = info.resumedChunks ? `（含 ${info.resumedChunks} 个已复用）` : '';
        job.log.push(`第 ${index} 章 · chunk ${info.chunkIndex + 1}/${info.chunkTotal} 已保存${tag}`);
      },
    });

    // 质量不合格且开启了自动重试 => 再跑一次
    let final = result;
    let qualityRetries = 0;
    const maxQualityRetries = settings.quality?.autoRetryOnFail ? settings.quality?.maxQualityRetries ?? 1 : 0;
    while (
      final.quality?.verdict === 'fail' &&
      qualityRetries < maxQualityRetries &&
      !job.controller.signal.aborted
    ) {
      qualityRetries += 1;
      job.log.push(`第 ${index} 章质量检查未通过，自动重试 ${qualityRetries}/${maxQualityRetries}`);
      final = await rewriteChapter({
        xhtml: originalXhtml,
        provider,
        providerForReview: reviewProvider,
        profile,
        settings,
        projectRoot,
        bookContext,
        bookMemory: memory,
        chapterTitle: baseStatus.title,
        chapterHref: baseStatus.href,
        chapterImages,
        signal: job.controller.signal,
        noteRefs,
        onChunkDone: async (info) => {
          await ws.saveChapterRewritten(job.bookId, index, info.doc.serialize());
        },
      });
    }

    await ws.saveChapterRewritten(job.bookId, index, final.xhtml);

    /**
     * 这一章原本有多少个脚注引用点，现在还剩几个。
     *
     * 就地化之后，引用点的 `<a>` 会被丢掉（`blockToPlainText` 故意不把它们
     * 放进 marks），所以**剩 0 个就是全部融进正文了**。
     * 这个数必须留下来：不然「脚注到底处理没处理」只能靠数成品里的链接，
     * 而那是导出之后的事了。
     */
    const noteRefsBefore = noteRefs
      ? [...noteRefs.keys()].filter((refId) => originalXhtml.includes(`id="${refId}"`)).length
      : 0;
    const noteRefsAfter = noteRefs
      ? [...noteRefs.keys()].filter((refId) => final.xhtml.includes(`id="${refId}"`)).length
      : 0;

    const stage = final.quality?.verdict === 'fail' ? 'failed' : 'completed';
    await ws.writeChapterStatus(job.bookId, index, {
      ...baseStatus,
      stage,
      chunkDone: baseStatus.chunkTotal,
      quality: final.quality,
      review: final.review,
      usage: final.usage,
      stats: final.stats,
      /** 第二遍补讲/删段的实际结果（界面与阅读路径页都要用） */
      explain: final.explain,
      warnings: final.warnings,
      durationMs: final.durationMs,
      originalChars: final.originalChars,
      rewrittenChars: final.rewrittenChars,
      qualityRetries,
      noteRefsBefore,
      noteRefsAfter,
      /**
       * 本章图片：总数、有几张拿到了模型说明、多少图注/整页图片块被原样保留。
       * 这些数必须来自实际改写用的那一份标注结果（final.images），
       * 不能拿 extraction 的旧数糊弄 —— 两张表可能不是同一版原文。
       */
      images: {
        ...(final.images || {}),
        visionCalls: imageStats?.visionCalls ?? 0,
        fromCache: imageStats?.fromCache ?? 0,
        captionFallback: imageStats?.captionFallback ?? 0,
        failed: imageStats?.failed ?? 0,
      },
      /**
       * 显式清掉上一轮的「这是压缩出来的」标记。
       *
       * `baseStatus` 是从旧状态展开来的，所以旧的 `digest: true` 会跟着传下来 ——
       * 一章从「压缩」改成「完整改写」之后，状态里还写着 digest，
       * 阅读路径页就会继续说它「已压缩为一页提要」，界面也继续标「已压缩为提要」。
       * 说的和做的对不上，而且很难查。
       */
      digest: false,
      digestText: null,
      note: null,
      error: stage === 'failed' ? summarizeQuality(final.quality) : null,
    });
    if (noteRefsBefore) {
      job.log.push(
        `第 ${index} 章 · 脚注就地化：${noteRefsBefore} 个引用点 → 成品里还剩 ${noteRefsAfter} 个`,
      );
    }

    addUsage(job.usage, final.usage);

    // Book Memory（可选）：每完成一章刷新一次
    if (settings.memory?.enabled && final.quality?.verdict !== 'fail') {
      try {
        const memoryPrompt = await loadPromptTemplate(projectRoot, settings.prompt?.memoryFile || 'prompts/memory-system.txt');
        const updated = await updateMemoryViaLlm({
          memory,
          chapterTitle: baseStatus.title,
          chapterIndex: index,
          chapterText: final.originalBodyText || originalXhtml,
          bookContext,
          provider,
          promptTemplate: memoryPrompt.template,
          signal: job.controller.signal,
        });
        const merged = mergeMemory(memory || ws.blankBookMemory(), updated.memory, index, baseStatus.title);
        await ws.writeBookMemory(job.bookId, merged);
        addUsage(job.usage, updated.usage);
        job.log.push(`第 ${index} 章记忆已更新`);
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        // 说明清楚：本章正文已经处理好并保存了，失败的只是「跨章一致性记忆」这一步。
        job.log.push(
          `第 ${index} 章：正文已保存，但 Book Memory 更新失败 —— ${err.message}` +
            `（可以在设置页关掉 Book Memory，或调大 Max tokens 后重跑这一章）`,
        );
      }
    }

    return stage === 'completed' ? 'completed' : 'failed';
  }

  /**
   * 全书的脚注索引，整个任务只算一次。
   *
   * 脚注必须**整本书一起认**：正文里的引用点和尾注里的条目是成对互指的，
   * 只看一章拼不出来（见 footnotes.buildNoteIndex）。
   * 拿到之后传给 `rewriteChapter`，模型就能在**原位**看到注释正文，
   * 自己决定是融进句子还是丢掉 —— 这是「脚注就地化」的全部机制。
   */
  async _noteRefsFor(job) {
    if (job._noteRefs === undefined) {
      try {
        const info = await buildBookNoteRefs(job.bookId);
        job._noteRefs = info.noteRefs;
        job._noteOwnerIndex = info.ownerIndex;
        job.log.push(
          `脚注索引：${info.totalNotes} 条注释，正文里 ${info.refToNote.size} 个引用点` +
            `（条目在第 ${info.ownerIndex} 章）`,
        );
      } catch (err) {
        job._noteRefs = null;
        job.log.push(`脚注索引构建失败，本次按普通改写处理：${err.message}`);
      }
    }
    return job._noteRefs;
  }

  /** 一键导出（可带 chapter 列表）。 */
  async exportNow({ bookId, chapters }) {
    return exportBook({ bookId, chapters });
  }

  /**
   * 这一章在规划里是什么策略。规划只读一次，整个任务期间不变。
   * 没有规划（用户没跑过 plan-book）时返回 null —— 一切按老规矩改写。
   */
  async _planEntryFor(job, index) {
    if (job._plan === undefined) {
      job._plan = await ws.readBookPlan(job.bookId).catch(() => null);
    }
    return (job._plan?.entries || []).find((e) => e.index === index) || null;
  }

  /**
   * 全书的入链分析，整个任务只算一次。
   *
   * 压缩任何一章之前都要问「有没有人指着它、指着哪个锚点」，
   * 答案必须来自**原始 EPUB**，不能用中间文件 —— 少算一个锚点，
   * 就会有读者点进目录是一片空白，而阅读器不会报任何错。
   */
  async _inboundFor(job) {
    if (!job._inbound) {
      job._inbound = await analyzeBookInboundLinks(job.bookId);
      job.log.push(`全书链接分析：${job._inbound.totalLinks} 条跨文件链接`);
    }
    return job._inbound;
  }

  /**
   * 把一章压成一页提要。
   *
   * 规则（见 src/epub/inbound-links.js 的说明）：
   *  - **带入链锚点的段落原样保留**，其余段落换成提要；
   *  - 标题永远保留，否则读者看到一段孤零零的提要，不知道在读什么；
   *  - 风险 `blocked`（锚点 > 100，整篇都是跳转目标）直接不压，
   *    宁可留着全文，也不能把全书的脚注和目录跳转切断。
   */
  async _digestOne(job, index, entry, { status, metadata }) {
    const { provider, profile, projectRoot, bookContext } = await this.getContext(job.bookId);

    // 先确保 original.xhtml 在（压缩读的是原文，不是上一次的改写结果）
    await extractChapter(job.bookId, index);
    const originalXhtml = await ws.readChapterOriginal(job.bookId, index);
    const chapterMeta = (metadata.chapters || []).find((c) => c.index === index);
    const title = entry.title || chapterMeta?.title || `第 ${index} 章`;

    const { anchorHits } = await this._inboundFor(job);
    const risk = digestRisk(index, anchorHits);
    if (risk.level === 'blocked') {
      await ws.writeChapterStatus(job.bookId, index, {
        ...(status || ws.blankChapterStatus({ index, title, href: chapterMeta?.href })),
        title,
        href: chapterMeta?.href,
        stage: 'skipped',
        digest: false,
        note: `规划要求压缩，但${risk.reason}。已保留全文。`,
      });
      job.log.push(`第 ${index} 章「${title}」：${risk.reason}，不压缩`);
      return 'skipped';
    }

    job.message = `第 ${index} 章 · 生成提要…`;
    const t0 = Date.now();
    const { text, usage } = await buildDigest({
      xhtml: originalXhtml,
      provider,
      profile,
      projectRoot,
      chapterIndex: index,
      chapterTitle: title,
      bookContext,
      signal: job.controller.signal,
    });
    if (!text) throw new Error(`第 ${index} 章提要生成为空，已中止（不会把章节清空）`);

    const applied = applyDigest({
      xhtml: originalXhtml,
      digestText: text,
      inboundAnchors: anchorHits.get(index) || new Set(),
    });

    /**
     * 自检：提要写完以后，**原本指向这一章的锚点必须一个不少**。
     *
     * 这是整件事唯一不能出错的地方 —— 删掉一个带锚点的段落，
     * 全书就多一条点不动的链接，而 EPUB 阅读器**不会报错**，
     * 读者点一下什么都不会发生，谁也不知道坏了。
     * 与其相信实现，不如写完自己数一遍。
     */
    const lost = [...(anchorHits.get(index) || [])].filter(
      (id) => !applied.xhtml.includes(`id="${id}"`) && !applied.xhtml.includes(`name="${id}"`),
    );
    if (lost.length) {
      throw new Error(
        `第 ${index} 章压缩后丢了 ${lost.length} 个入链锚点（${lost.slice(0, 3).join('、')}…），已中止，原文未改动`,
      );
    }

    await ws.saveChapterRewritten(job.bookId, index, applied.xhtml);
    const digestChars = text.replace(/\s+/g, '').length;
    /**
     * 落盘后的**实际**正文长度，而不是提要本身的长度。
     *
     * 带锚点的块是原样留下的（第 13 章保留了 21 块），所以成品字数 =
     * 提要 + 这些块。只报提要多长会显示成「原文 12496 字 → 改写后 501 字」，
     * 用户会以为整章被删光了 —— 而实际上正文还在。
     */
    const resultChars = bodyTextLength(applied.xhtml);
    await ws.writeChapterStatus(job.bookId, index, {
      ...(status || ws.blankChapterStatus({ index, title, href: chapterMeta?.href })),
      title,
      href: chapterMeta?.href,
      stage: 'completed',
      digest: true,
      digestText: text,
      chunkTotal: 0,
      chunkDone: 0,
      quality: null,
      error: null,
      usage,
      originalChars: entry.chars || status?.originalChars || 0,
      rewrittenChars: resultChars,
      stats: {
        digestChars,
        keptBlocks: applied.keptBlocks,
        replacedBlocks: applied.replacedBlocks,
        digestParagraphs: applied.digestParagraphs,
        inboundAnchors: (anchorHits.get(index) || new Set()).size,
        risk: risk.level,
      },
      durationMs: Date.now() - t0,
      note: `按规划压缩为一页提要（提要 ${digestChars} 字，另有 ${applied.keptBlocks} 个带锚点的块原样保留）`,
    });

    addUsage(job.usage, usage);
    job.log.push(
      `第 ${index} 章「${title}」已压缩：${entry.chars || '?'} → 提要 ${digestChars} 字` +
        `（成品正文 ${resultChars} 字，保留 ${applied.keptBlocks} 块 / 替换 ${applied.replacedBlocks} 块）`,
    );
    return 'completed';
  }
}

function describeProgress(info) {
  if (!info) return '';
  if (info.phase === 'retry') return info.reason || `重试中（第 ${info.attempt} 次）`;
  if (info.chunk !== undefined) return `chunk ${info.chunk + 1} ${info.phase || ''}`.trim();
  return info.phase || '';
}

function summarizeQuality(quality) {
  if (!quality) return '质量检查未通过';
  const fails = (quality.issues || []).filter((i) => i.severity === 'fail').map((i) => i.message);
  return fails.length ? fails.join('；') : '质量检查未通过';
}

/**
 * 把模型返回的「记忆增量」并入已有记忆。
 *
 * 兼容两种返回形态：
 *  - 增量（推荐，prompt 要求的）：只包含本章新增/修正的条目；
 *  - 全量（旧行为，某些模型会自作主张）：包含完整记忆。
 * 两种都能正确合并，所以换 prompt 不会让已有书的数据变乱。
 *
 * 去重规则按字段语义区分：terminology 按 term 去重（同一个词换译法要能覆盖），
 * 其余按整条内容去重。
 */
export function mergeMemory(current, incoming, chapterIndex, chapterTitle) {
  const base = { ...ws.blankBookMemory(), ...(current || {}) };
  if (!incoming || typeof incoming !== 'object') return base;

  const normalize = (item) => (typeof item === 'string' ? item.trim() : item);

  const listMerge = (a, b, max, keyOf) => {
    const out = [...(Array.isArray(a) ? a : [])].map(normalize).filter(Boolean);
    for (const raw of Array.isArray(b) ? b : []) {
      const item = normalize(raw);
      if (!item) continue;
      const key = keyOf(item);
      const idx = out.findIndex((x) => keyOf(x) === key);
      if (idx >= 0) {
        out[idx] = item; // 同一实体的新信息覆盖旧的（例如术语译法修正）
      } else {
        out.push(item);
      }
    }
    return out.slice(-max);
  };

  const genericKey = (item) => JSON.stringify(item).toLowerCase();
  const termKey = (item) => {
    if (typeof item === 'string') return item.toLowerCase();
    const term = item?.term ?? item?.name ?? '';
    return String(term).toLowerCase();
  };

  const merged = {
    ...base,
    book_summary:
      typeof incoming.book_summary === 'string' && incoming.book_summary.trim()
        ? incoming.book_summary.trim().slice(0, 4000)
        : base.book_summary,
    important_concepts: listMerge(base.important_concepts, incoming.important_concepts, 60, genericKey),
    people: listMerge(base.people, incoming.people, 80, genericKey),
    terminology: listMerge(base.terminology, incoming.terminology, 80, termKey),
    author_positions: listMerge(base.author_positions, incoming.author_positions, 40, genericKey),
    chapter_summaries: {
      ...(base.chapter_summaries || {}),
      ...(incoming.chapter_summaries && typeof incoming.chapter_summaries === 'object'
        ? incoming.chapter_summaries
        : {}),
    },
  };

  // 模型有时会把摘要放到别的键名下，兜一下，避免白跑一次调用
  const key = String(chapterIndex);
  if (!merged.chapter_summaries[key]) {
    const fallback =
      incoming.chapter_summary ??
      incoming.summary ??
      (incoming.chapter_summaries ? Object.values(incoming.chapter_summaries)[0] : null);
    if (typeof fallback === 'string' && fallback.trim()) {
      merged.chapter_summaries[key] = fallback.trim().slice(0, 600);
    } else if (chapterTitle) {
      merged.chapter_summaries[key] = '';
    }
  }

  return merged;
}

function addUsage(target, usage) {
  if (!usage) return;
  target.promptTokens += usage.promptTokens || 0;
  target.completionTokens += usage.completionTokens || 0;
  target.totalTokens += usage.totalTokens || 0;
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    mode: job.mode,
    bookId: job.bookId,
    chapters: job.chapters,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    currentChapter: job.currentChapter,
    completed: job.completed,
    failed: job.failed,
    skipped: job.skipped,
    message: job.message,
    error: job.error,
    usage: job.usage,
    log: job.log.slice(-100),
    result: job.result,
  };
}
