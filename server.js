/**
 * hive-ad-bid — IntraAgent Advertising Stack
 * Second-price sealed-bid auction engine + impression ledger + daily x402 billing.
 *
 * Modules: ad-bid | ad-server | impression-ledger | ad-billing
 * Network: Base 8453 / USDC mainnet / x402
 * Monroe: 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 * Hive take: 15% of every cleared CPM.
 *
 * © The Hivery. MIT License.
 */

import express from 'express';
import { randomUUID, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { runAuction, resolveTagTier, HIVE_TAKE_PCT, impressionCostAtomic } from './lib/auction.js';
import { appendImpression, readAllImpressions, auditAdvertiser, getReceipt, SPECTRAL_PUBKEY_B64 } from './lib/ledger.js';
import { computeOwed, recordSettlement, getBillingHealth, isSuspended, runDailyAggregation, readSettlements } from './lib/billing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Monroe settlement address (Base 8453, USDC)
const MONROE_ADDRESS = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;

// In-memory bid store: Map<bid_id, bid>
const bids = new Map();

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function getSuspendedDIDs() {
  const suspended = new Set();
  for (const [did] of bids) {
    if (isSuspended(did)) suspended.add(did);
  }
  return suspended;
}

function count24hImpressions() {
  const all = readAllImpressions();
  const cutoff = Date.now() - 86400000;
  return all.filter(r => new Date(r.logged_at).getTime() > cutoff).length;
}

function total24hSettled() {
  const sett = readSettlements();
  const cutoff = Date.now() - 86400000;
  const recent = sett.filter(s => new Date(s.paid_at).getTime() > cutoff);
  const totalAtomic = recent.reduce((a, s) => a + (s.amount_paid_atomic || 0), 0);
  return (totalAtomic / 1e6).toFixed(6);
}

// Build x402 challenge for a given advertiser DID and amount
function build402(total_owed_atomic, advertiser_did) {
  return {
    error: 'Payment Required',
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        chainId: CHAIN_ID,
        asset: 'USDC',
        maxAmountRequired: total_owed_atomic,
        payTo: MONROE_ADDRESS,
        contract: USDC_CONTRACT,
        resource: '/v1/billing/sweep',
        description: `Pay advertised impressions billed for the last 24h. Advertiser: ${advertiser_did}.`,
        mimeType: 'application/json',
      }
    ],
    advertiser_did,
    total_owed_atomic,
    total_owed_usdc: (total_owed_atomic / 1e6).toFixed(6),
  };
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'hive-ad-bid',
    version: '1.0.0',
    total_active_bids: [...bids.values()].filter(b => new Date(b.expires_at).getTime() > Date.now()).length,
    total_impressions_24h: count24hImpressions(),
    total_settled_usdc_24h: total24hSettled(),
    hive_take_pct: HIVE_TAKE_PCT,
    monroe: MONROE_ADDRESS,
    ts: nowIso(),
  });
});

// ---------------------------------------------------------------------------
// GET / — banner
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    service: 'hive-ad-bid',
    description: 'IntraAgent advertising — second-price sealed-bid auction, impression ledger, daily x402 billing.',
    version: '1.0.0',
    brand: '#C08D23',
    hive_take_pct: HIVE_TAKE_PCT,
    settlement: { network: 'base', asset: 'USDC', payTo: MONROE_ADDRESS },
    docs: 'https://github.com/srotzin/hive-ad-bid',
    endpoints: [
      'POST /v1/ad/bid',
      'GET /v1/ad/bid/:bid_id',
      'POST /v1/ad/bid/:bid_id/cancel',
      'POST /v1/ad/decide',
      'GET /v1/impressions/audit/:advertiser_did',
      'GET /v1/impressions/receipt/:impression_id',
      'POST /v1/billing/sweep',
      'GET /v1/billing/owed/:advertiser_did',
      'GET /v1/billing/health/:advertiser_did',
      'POST /mcp',
      'GET /.well-known/agent.json',
    ],
  });
});

// ---------------------------------------------------------------------------
// GET /.well-known/agent.json
// ---------------------------------------------------------------------------
app.get('/.well-known/agent.json', (req, res) => {
  const tagTiers = JSON.parse(readFileSync(join(__dirname, 'data/tag_tiers.json'), 'utf8'));
  res.json({
    name: 'hive-ad-bid',
    description: 'IntraAgent advertising stack — second-price sealed-bid CPM auction, HMAC impression ledger, daily x402 USDC settlement on Base.',
    version: '1.0.0',
    brand_color: '#C08D23',
    url: 'https://hive-ad-bid.onrender.com',
    mcp_endpoint: 'https://hive-ad-bid.onrender.com/mcp',
    settlement: {
      network: 'base',
      chain_id: CHAIN_ID,
      asset: 'USDC',
      contract: USDC_CONTRACT,
      payTo: MONROE_ADDRESS,
    },
    spectral_pubkey: SPECTRAL_PUBKEY_B64 || process.env.SPECTRAL_PUBKEY_B64 || null,
    spectral_signature_scheme: 'ed25519',
    compatible_with: ['hive-attest-agentic-volume'],
    pricing: {
      hive_take_pct: HIVE_TAKE_PCT,
      commodity_cpm_floor_usdc: 0.10,
      common_cpm_floor_usdc: 1.00,
      premium_cpm_floor_usdc: 5.00,
      trophy_cpm_floor_usdc: 25.00,
      note: 'Costs are per-CPM (per 1000 impressions). Billing is per individual impression at clearing_cpm / 1000.',
    },
    tag_tiers: tagTiers.tiers,
    capabilities: [
      { tool: 'bid', description: 'Submit a CPM bid for an ad slot on a given tag.' },
      { tool: 'decide', description: 'Run second-price auction and return ranked ad slots. Call inline from hive-discovery, hive-marketplace-agent, hive-matchmaker.' },
      { tool: 'audit_impressions', description: 'Read auditable impression count and owed total for an advertiser DID.' },
      { tool: 'billing_owed', description: 'Get current net owed USDC for an advertiser DID.' },
      { tool: 'billing_health', description: 'Get billing status: active | grace | suspended.' },
    ],
    integration_pattern: {
      description: 'To embed ads in any Hive agent: POST /v1/ad/decide with {tag, slot_count, query_did, query_context}. Render the returned headline+link in your agent response. Each call auto-logs an impression and accrues billing.',
      callers: ['hive-discovery', 'hive-marketplace-agent', 'hive-matchmaker'],
    },
  });
});

// ---------------------------------------------------------------------------
// MODULE 1: AD-BID
// ---------------------------------------------------------------------------

// POST /v1/ad/bid — submit a new bid
app.post('/v1/ad/bid', (req, res) => {
  const { advertiser_did, tag, headline, link, max_cpm_atomic, daily_cap_atomic, expires_at } = req.body || {};

  if (!advertiser_did || !tag || !headline || !link || !max_cpm_atomic || !expires_at) {
    return res.status(400).json({ error: 'Missing required fields: advertiser_did, tag, headline, link, max_cpm_atomic, expires_at' });
  }
  if (typeof headline !== 'string' || headline.length > 80) {
    return res.status(400).json({ error: 'headline must be a string of 80 characters or fewer.' });
  }
  if (typeof max_cpm_atomic !== 'number' || max_cpm_atomic <= 0) {
    return res.status(400).json({ error: 'max_cpm_atomic must be a positive integer.' });
  }

  const tierInfo = resolveTagTier(tag);
  if (max_cpm_atomic < tierInfo.floor_atomic) {
    return res.status(400).json({
      error: `Bid below reserve floor. Tag tier "${tierInfo.tier}" requires min ${tierInfo.floor_atomic} atomic (${tierInfo.floor_usdc} USDC CPM).`,
      tier: tierInfo,
    });
  }

  const bid_id = randomUUID();
  const bid = {
    bid_id,
    advertiser_did,
    tag,
    headline: headline.trim(),
    link,
    max_cpm_atomic: Math.floor(max_cpm_atomic),
    daily_cap_atomic: daily_cap_atomic ? Math.floor(daily_cap_atomic) : null,
    expires_at,
    submitted_at: nowIso(),
    status: 'active',
    tier: tierInfo.tier,
  };
  bids.set(bid_id, bid);

  res.status(201).json({ bid_id, status: 'active', tier: tierInfo.tier, floor_atomic: tierInfo.floor_atomic, submitted_at: bid.submitted_at });
});

// GET /v1/ad/bid/:bid_id — read bid status
app.get('/v1/ad/bid/:bid_id', (req, res) => {
  const bid = bids.get(req.params.bid_id);
  if (!bid) return res.status(404).json({ error: 'Bid not found.' });
  const now = Date.now();
  const expired = new Date(bid.expires_at).getTime() < now;
  res.json({ ...bid, computed_status: expired ? 'expired' : bid.status });
});

// POST /v1/ad/bid/:bid_id/cancel — cancel own bid (DID-signed via query param or body)
app.post('/v1/ad/bid/:bid_id/cancel', (req, res) => {
  const bid = bids.get(req.params.bid_id);
  if (!bid) return res.status(404).json({ error: 'Bid not found.' });

  const caller_did = req.body?.advertiser_did || req.query.advertiser_did;
  if (!caller_did || caller_did !== bid.advertiser_did) {
    return res.status(403).json({ error: 'DID mismatch. Only the bid owner may cancel.' });
  }

  bid.status = 'cancelled';
  bid.cancelled_at = nowIso();
  bids.set(bid.bid_id, bid);

  res.json({ bid_id: bid.bid_id, status: 'cancelled', cancelled_at: bid.cancelled_at });
});

// ---------------------------------------------------------------------------
// MODULE 2: AD-SERVER
// ---------------------------------------------------------------------------

// POST /v1/ad/decide — run second-price auction, return ranked ad slots
app.post('/v1/ad/decide', (req, res) => {
  const { tag, slot_count = 1, query_did, query_context } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'Missing required field: tag' });

  const n = Math.min(Math.max(1, parseInt(slot_count) || 1), 10);
  const activeBids = [...bids.values()].filter(b => b.status === 'active');
  const suspendedDIDs = getSuspendedDIDs();

  const start = Date.now();
  const winners = runAuction(activeBids, tag, n, suspendedDIDs);
  const elapsed_ms = Date.now() - start;

  // Log impressions for each winner
  const slots = winners.map(w => {
    const impression_id = randomUUID();
    const cost_atomic = impressionCostAtomic(w.clearing_cpm_atomic);
    const expires_at = new Date(Date.now() + 3600000).toISOString(); // 1h TTL on impression
    appendImpression({
      impression_id,
      advertiser_did: w.advertiser_did,
      bid_id: w.bid_id,
      tag,
      clearing_cpm_atomic: w.clearing_cpm_atomic,
      cost_atomic,
      query_did: query_did || null,
      query_context: query_context || null,
      rank: w.rank,
    });
    return {
      ad_id: w.bid_id,
      advertiser_did: w.advertiser_did,
      headline: w.headline,
      link: w.link,
      clearing_cpm_atomic: w.clearing_cpm_atomic,
      clearing_cpm_usdc: (w.clearing_cpm_atomic / 1e6).toFixed(6),
      impression_id,
      expires_at,
      rank: w.rank,
    };
  });

  res.json({
    tag,
    slots_requested: n,
    slots_filled: slots.length,
    ad_slots: slots,
    auction_elapsed_ms: elapsed_ms,
    ts: nowIso(),
  });
});

// ---------------------------------------------------------------------------
// MODULE 3: IMPRESSION-LEDGER
// ---------------------------------------------------------------------------

// GET /v1/impressions/audit/:advertiser_did
app.get('/v1/impressions/audit/:advertiser_did', (req, res) => {
  const result = auditAdvertiser(req.params.advertiser_did);
  res.json(result);
});

// GET /v1/impressions/receipt/:impression_id
app.get('/v1/impressions/receipt/:impression_id', (req, res) => {
  const receipt = getReceipt(req.params.impression_id);
  if (!receipt) return res.status(404).json({ error: 'Impression not found.' });
  res.json(receipt);
});

// ---------------------------------------------------------------------------
// MODULE 4: AD-BILLING
// ---------------------------------------------------------------------------

// POST /v1/billing/sweep — 402-gated settlement endpoint
app.post('/v1/billing/sweep', (req, res) => {
  const paymentHeader = req.headers['x-payment'];
  const advertiser_did = req.body?.advertiser_did || req.query.advertiser_did;

  if (!advertiser_did) {
    return res.status(400).json({ error: 'Missing advertiser_did.' });
  }

  const owedInfo = computeOwed(advertiser_did);
  if (owedInfo.net_owed_atomic <= 0) {
    return res.json({ message: 'No outstanding balance.', advertiser_did, net_owed_atomic: 0 });
  }

  if (!paymentHeader) {
    // Issue 402 challenge
    res.setHeader('Content-Type', 'application/json');
    return res.status(402).json(build402(owedInfo.net_owed_atomic, advertiser_did));
  }

  // Payment header present — validate and record
  // In production: verify x402 USDC payment on Base via payment verification service.
  // For this scaffold: accept any non-empty X-PAYMENT header as proof-of-payment.
  const txRef = `x402-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const settlement = recordSettlement(advertiser_did, owedInfo.net_owed_atomic, paymentHeader, txRef);

  res.json({
    settled: true,
    advertiser_did,
    amount_paid_atomic: settlement.amount_paid_atomic,
    amount_paid_usdc: (settlement.amount_paid_atomic / 1e6).toFixed(6),
    tx_ref: txRef,
    paid_at: settlement.paid_at,
  });
});

// GET /v1/billing/owed/:advertiser_did
app.get('/v1/billing/owed/:advertiser_did', (req, res) => {
  const result = computeOwed(req.params.advertiser_did);
  res.json(result);
});

// GET /v1/billing/health/:advertiser_did
app.get('/v1/billing/health/:advertiser_did', (req, res) => {
  const result = getBillingHealth(req.params.advertiser_did);
  res.json(result);
});

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 endpoint — 5 tools
// ---------------------------------------------------------------------------
const MCP_TOOLS = [
  {
    name: 'bid',
    description: 'Submit a CPM bid for an ad slot on a given tag. Bids are free to post; billing occurs per impression on ad-serve.',
    inputSchema: {
      type: 'object',
      properties: {
        advertiser_did: { type: 'string', description: 'DID of the advertiser.' },
        tag: { type: 'string', description: 'Ad slot tag (e.g. compute, compliance, ping).' },
        headline: { type: 'string', maxLength: 80, description: 'Ad headline, 80 chars max.' },
        link: { type: 'string', description: 'Destination URL or agent endpoint.' },
        max_cpm_atomic: { type: 'number', description: 'Max CPM willing to pay, in USDC atomic units (1 USDC = 1,000,000 atomic).' },
        daily_cap_atomic: { type: 'number', description: 'Optional daily spend cap in atomic units.' },
        expires_at: { type: 'string', description: 'ISO 8601 expiry timestamp for the bid.' },
      },
      required: ['advertiser_did', 'tag', 'headline', 'link', 'max_cpm_atomic', 'expires_at'],
    },
  },
  {
    name: 'decide',
    description: 'Run second-price CPM auction for a given tag and slot count. Returns ranked ad slots. Call inline from hive-discovery, hive-marketplace-agent, hive-matchmaker.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Ad slot tag.' },
        slot_count: { type: 'number', description: 'Number of ad slots to fill (1-10).' },
        query_did: { type: 'string', description: 'DID of the requesting agent (for attribution).' },
        query_context: { type: 'string', description: 'Optional context string for logging.' },
      },
      required: ['tag'],
    },
  },
  {
    name: 'audit_impressions',
    description: 'Return auditable impression count and owed total for an advertiser DID.',
    inputSchema: {
      type: 'object',
      properties: {
        advertiser_did: { type: 'string', description: 'DID of the advertiser to audit.' },
      },
      required: ['advertiser_did'],
    },
  },
  {
    name: 'billing_owed',
    description: 'Return current net owed USDC for an advertiser DID.',
    inputSchema: {
      type: 'object',
      properties: {
        advertiser_did: { type: 'string', description: 'DID of the advertiser.' },
      },
      required: ['advertiser_did'],
    },
  },
  {
    name: 'billing_health',
    description: 'Return billing status (active | grace | suspended) for an advertiser DID.',
    inputSchema: {
      type: 'object',
      properties: {
        advertiser_did: { type: 'string', description: 'DID of the advertiser.' },
      },
      required: ['advertiser_did'],
    },
  },
];

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }

  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};

    try {
      let result;

      if (name === 'bid') {
        const { advertiser_did, tag, headline, link, max_cpm_atomic, daily_cap_atomic, expires_at } = args;
        if (!advertiser_did || !tag || !headline || !link || !max_cpm_atomic || !expires_at) {
          throw new Error('Missing required bid fields.');
        }
        if (headline.length > 80) throw new Error('headline exceeds 80 characters.');
        const tierInfo = resolveTagTier(tag);
        if (max_cpm_atomic < tierInfo.floor_atomic) {
          throw new Error(`Bid below reserve floor for tier "${tierInfo.tier}": ${tierInfo.floor_atomic} atomic.`);
        }
        const bid_id = randomUUID();
        const bid = {
          bid_id, advertiser_did, tag, headline: headline.trim(), link,
          max_cpm_atomic: Math.floor(max_cpm_atomic),
          daily_cap_atomic: daily_cap_atomic ? Math.floor(daily_cap_atomic) : null,
          expires_at, submitted_at: nowIso(), status: 'active', tier: tierInfo.tier,
        };
        bids.set(bid_id, bid);
        result = { bid_id, status: 'active', tier: tierInfo.tier };

      } else if (name === 'decide') {
        const { tag, slot_count = 1, query_did, query_context } = args;
        if (!tag) throw new Error('tag is required.');
        const n = Math.min(Math.max(1, parseInt(slot_count) || 1), 10);
        const activeBids = [...bids.values()].filter(b => b.status === 'active');
        const suspendedDIDs = getSuspendedDIDs();
        const winners = runAuction(activeBids, tag, n, suspendedDIDs);
        const slots = winners.map(w => {
          const impression_id = randomUUID();
          const cost_atomic = impressionCostAtomic(w.clearing_cpm_atomic);
          appendImpression({ impression_id, advertiser_did: w.advertiser_did, bid_id: w.bid_id, tag, clearing_cpm_atomic: w.clearing_cpm_atomic, cost_atomic, query_did: query_did || null, query_context: query_context || null, rank: w.rank });
          return { ad_id: w.bid_id, advertiser_did: w.advertiser_did, headline: w.headline, link: w.link, clearing_cpm_atomic: w.clearing_cpm_atomic, impression_id, rank: w.rank };
        });
        result = { tag, slots_filled: slots.length, ad_slots: slots };

      } else if (name === 'audit_impressions') {
        result = auditAdvertiser(args.advertiser_did);

      } else if (name === 'billing_owed') {
        result = computeOwed(args.advertiser_did);

      } else if (name === 'billing_health') {
        result = getBillingHealth(args.advertiser_did);

      } else {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${name}` } });
      }

      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });

    } catch (err) {
      return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
    }
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
});

// ---------------------------------------------------------------------------
// Daily billing cron — 00:15 UTC
// ---------------------------------------------------------------------------
function scheduleDailyBilling() {
  function msUntilNext0015() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 15, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function tick() {
    console.log(`[billing-cron] Running daily aggregation at ${nowIso()}`);
    const result = runDailyAggregation();
    console.log(`[billing-cron] Aggregated:`, JSON.stringify(result));
    setTimeout(tick, msUntilNext0015());
  }

  setTimeout(tick, msUntilNext0015());
  console.log(`[billing-cron] Scheduled for 00:15 UTC. Next run in ${Math.round(msUntilNext0015() / 60000)} min.`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`hive-ad-bid v1.0.0 running on port ${PORT}`);
  console.log(`Monroe: ${MONROE_ADDRESS} | Chain: Base ${CHAIN_ID} | Take: ${HIVE_TAKE_PCT}%`);
  console.log(`Spectral pubkey present: ${!!(SPECTRAL_PUBKEY_B64 || process.env.SPECTRAL_PUBKEY_B64)}`);
  scheduleDailyBilling();
});

export default app;
