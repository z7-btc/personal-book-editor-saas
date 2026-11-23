/**
 * E2E 用的假模型服务：浏览器测试时由 `book-retry.spec.ts` 拉起。
 *
 * 复用引擎测试的 mock-llm.js，行为与单元测试完全一致：
 * 正常改写、保留占位符和数字，足以让一章真的跑完质量检查。
 *
 * 用法：node tests/e2e/mock-llm-server.mjs [port]
 * 启动后向 stdout 打一行 `ready <port>`，测试据此拿到真实端口。
 */
import { createMockLlmServer } from '../book-engine/mock-llm.js';

const port = Number(process.argv[2] || 0);
const server = createMockLlmServer({ behavior: process.env.MOCK_BEHAVIOR || 'normal' });

server.listen(port, '127.0.0.1').then((info) => {
  process.stdout.write(`ready ${info.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close().finally(() => process.exit(0));
  });
}
