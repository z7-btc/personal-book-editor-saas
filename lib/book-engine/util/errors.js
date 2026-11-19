/**
 * 统一错误类型。所有面向用户的错误都带 code，前端可直接展示 message。
 */

export class AppError extends Error {
  /**
   * @param {string} message 面向用户的中文提示
   * @param {{code?: string, status?: number, cause?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = opts.code || 'APP_ERROR';
    this.status = opts.status || 400;
    this.expose = true;
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, { code: 'NOT_FOUND', status: 404 });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, { code: 'VALIDATION', status: 400 });
    this.name = 'ValidationError';
  }
}

/** EPUB 结构不合法 / 不支持 */
export class EpubError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: opts.code || 'EPUB_ERROR', status: 422, cause: opts.cause });
    this.name = 'EpubError';
  }
}

/** ZIP 层面的问题（不是 zip、方法不支持、CRC 不符…） */
export class ZipError extends EpubError {
  constructor(message, opts = {}) {
    super(message, { code: opts.code || 'ZIP_ERROR', cause: opts.cause });
    this.name = 'ZipError';
  }
}

/** 外部 API / LLM 调用失败 */
export class LlmError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: opts.code || 'LLM_ERROR', status: opts.status || 502, cause: opts.cause });
    this.name = 'LlmError';
    this.retryable = Boolean(opts.retryable);
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** 被用户暂停 / 取消 */
export class AbortedError extends AppError {
  constructor(message = '任务已暂停') {
    super(message, { code: 'ABORTED', status: 409 });
    this.name = 'AbortedError';
  }
}
