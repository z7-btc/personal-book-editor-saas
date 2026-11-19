import { createServer } from 'node:http';

const port = 4871;
let latest: { to: string[]; text: string; subject: string } | null = null;
let failNext = false;
const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/fail-next') {
    failNext = true;
    response.writeHead(200).end();
    return;
  }
  if (request.method === 'POST' && request.url === '/emails') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    if (failNext) {
      failNext = false;
      response.writeHead(503).end();
      return;
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(body.to) || typeof body.text !== 'string' ||
          typeof body.subject !== 'string' || !request.headers['idempotency-key']) {
        throw new Error('Invalid mock mail.');
      }
      latest = { to: body.to, text: body.text, subject: body.subject };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'local-verification-mail' }));
    } catch {
      response.writeHead(400).end();
    }
    return;
  }
  if (request.method === 'GET' && request.url === '/latest') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ mail: latest }));
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Mock transactional mail ready on 127.0.0.1:${port}\n`);
});
