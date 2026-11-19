import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const port = 4872;
const websiteId = process.env.PAYMENT_CENTER_WEBSITE_ID;
const signingSecret = process.env.REFERRAL_WITHDRAWAL_REQUEST_SECRET;
if (!websiteId || !signingSecret || signingSecret.length < 32) {
  throw new Error('Mock withdrawal binding is incomplete.');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  const match = url.pathname.match(/^\/api\/referral-center\/users\/([^/]+)\/(summary|ledger)$/);
  if (request.method === 'GET' && match) {
    const userId = decodeURIComponent(match[1]);
    const data = match[2] === 'summary' ? {
      exists: true,
      user: { id: `remote-${userId}`, website_id: websiteId, external_user_id: userId },
      balance: {
        currency: 'USDT', available_amount_decimal: '100.00000000',
        verified_available_amount_decimal: '100.00000000',
        pending_amount_decimal: '0.00000000', withdrawn_amount_decimal: '0.00000000',
        total_earned_decimal: '100.00000000',
      },
      invite_count: 0, order_count: 0, tier: { name: 'Local test' },
      next_tier: null, effective_rates: [], maintenance_mode: false,
      withdrawal_enabled: true, withdrawal_minimum_amount_decimal: '1.00000000',
    } : { currency: 'USDT', ledger: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'success', data }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/referral-center/withdrawals') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'success', data: {
      currency: 'USDT', withdrawals: [],
    } }));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/referral-center/withdrawals') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const timestamp = request.headers['x-withdrawal-timestamp'];
    const nonce = request.headers['x-withdrawal-nonce'];
    const signature = request.headers['x-withdrawal-signature'];
    // The real centre separates parts with a LITERAL backslash-n pair, not a
    // newline; this mock must match it or the dispatch's signing bug hides here.
    const expected = createHmac('sha256', signingSecret)
      .update(['POST', url.pathname, raw, timestamp, nonce].join('\\n')).digest('hex');
    if (signature !== expected || request.headers['x-api-key'] !== 'local-withdrawal-mock-key') {
      response.writeHead(401).end();
      return;
    }
    try {
      const body = JSON.parse(raw);
      const withdrawal = {
        id: `remote-${body.external_withdrawal_id}`, website_id: websiteId,
        referral_user_id: `remote-${body.external_user_id}`,
        external_withdrawal_id: body.external_withdrawal_id,
        amount_decimal: body.amount, currency: body.currency,
        method: body.blockchain ? `BLOCKCHAIN_${body.blockchain}` : body.method,
        payout_account: body.payout_account, status: 'requested',
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'success', data: {
        success: true, idempotent: false, withdrawal,
      } }));
    } catch {
      response.writeHead(400).end();
    }
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Mock withdrawal center ready on 127.0.0.1:${port}\n`);
});
