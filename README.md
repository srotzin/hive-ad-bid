# hive-ad-bid

**IntraAgent advertising — second-price sealed-bid CPM auction, HMAC impression ledger, daily x402 USDC settlement on Base.**

One service. Four modules: ad-bid, ad-server, impression-ledger, ad-billing. The agent ad exchange for the Hive ecosystem.

---

## Overview

`hive-ad-bid` provides a complete advertising stack for agent-to-agent surfaces. Advertisers submit CPM bids. The ad-server runs a second-price (Vickrey) sealed-bid auction on every call. Every impression is cryptographically logged. Billing aggregates daily and issues x402 payment challenges in USDC on Base mainnet.

**Settlement address (Monroe):** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`  
**Network:** Base 8453 — USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`  
**Hive take rate:** 15% of every cleared CPM  
**Brand:** `#C08D23`

---

## MCP Tools

| Tool | Description |
|---|---|
| `bid` | Submit a CPM bid for an ad slot on a given tag |
| `decide` | Run second-price auction; returns ranked ad slots |
| `audit_impressions` | Auditable impression count and owed total for an advertiser DID |
| `billing_owed` | Current net owed USDC for an advertiser DID |
| `billing_health` | Billing status: `active` \| `grace` \| `suspended` |

**MCP endpoint:** `https://hive-ad-bid.onrender.com/mcp`  
**Protocol:** JSON-RPC 2.0 / MCP 2024-11-05 / Streamable-HTTP

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service health + live counters |
| GET | `/` | Service banner |
| GET | `/.well-known/agent.json` | Agent card with Monroe, Spectral pubkey, tag tiers, pricing |
| POST | `/mcp` | JSON-RPC 2.0 — 5 tools |
| POST | `/v1/ad/bid` | Submit bid |
| GET | `/v1/ad/bid/:bid_id` | Read bid status |
| POST | `/v1/ad/bid/:bid_id/cancel` | Cancel own bid (DID-signed) |
| POST | `/v1/ad/decide` | Run auction — returns ranked ad slots + impression IDs |
| GET | `/v1/impressions/audit/:advertiser_did` | Impression audit summary |
| GET | `/v1/impressions/receipt/:impression_id` | Single-impression receipt (ed25519-signed) |
| POST | `/v1/billing/sweep` | 402-gated settlement — accepts X-PAYMENT on Base USDC |
| GET | `/v1/billing/owed/:advertiser_did` | Current net owed |
| GET | `/v1/billing/health/:advertiser_did` | Billing status |

---

## Tag Tier System

CPM reserve floors by tag tier. Bids below the floor for their tag are rejected at submission.

| Tier | CPM Floor (USDC) | CPM Floor (atomic) | Example Tags |
|---|---|---|---|
| `commodity` | $0.10 | 100,000 | echo, ping, health, status, test |
| `common` | $1.00 | 1,000,000 | compute, storage, router, relay, cache |
| `premium` | $5.00 | 5,000,000 | compliance, audit, conformance, attestation |
| `trophy` | $25.00 | 25,000,000 | tier-1-agent, volume-attestation, coinbase-mirror |

**Atomic units:** 1 USDC = 1,000,000 atomic (6-decimal USDC on Base).

**Tag classification:** Tags are matched case-insensitively against the tier arrays in `/data/tag_tiers.json`. Priority order: `trophy > premium > common > commodity`. Unknown tags default to `commodity`. To expand the tag map, add entries to the appropriate tier array in that file.

---

## Auction Mechanics

`hive-ad-bid` implements a **second-price sealed-bid (Vickrey-extended) auction** for N slots:

1. All active, non-expired, non-suspended bids for the requested tag are collected.
2. Bids are ranked descending by `max_cpm_atomic`.
3. The top N bids win the N slots.
4. Each winner pays the **(N+1)th-highest bid** — the marginal clearing price.
5. If fewer than N+1 eligible bids exist, winners pay the **reserve floor** for the tag tier.

This structure is incentive-compatible: truth-telling is a dominant strategy. Advertisers should bid their true willingness to pay.

**Pricing formula:**

```
clearing_cpm_atomic = max(floor_atomic, bid_at_rank_(N+1)_atomic)
cost_per_impression_atomic = floor(clearing_cpm_atomic / 1000)
hive_share_atomic = floor(cost_per_impression_atomic * 0.15)
```

### Worked examples

**Small advertiser** (commodity tag, `ping`):
- Three bidders: 150,000 / 120,000 / 80,000 atomic, slot_count=1
- Winner: bidder at 150,000. Clearing price: 120,000 atomic (2nd price).
- Cost per impression: `floor(120,000 / 1000)` = 120 atomic = $0.000120 USDC
- Hive take: 18 atomic per impression

**Medium advertiser** (common tag, `compute`):
- Three bidders: 3,000,000 / 2,500,000 / 1,800,000 atomic, slot_count=2
- Winners: bidders at 3M and 2.5M. Clearing price: 1,800,000 atomic (3rd price).
- Cost per impression: 1,800 atomic = $0.001800 USDC per impression
- Hive take: 270 atomic per impression

**Large advertiser** (trophy tag, `tier-1-agent`):
- Two bidders: 50,000,000 / 30,000,000 atomic, slot_count=1
- Winner: 50M bid. Clearing price: 30,000,000 atomic (2nd price).
- Cost per impression: 30,000 atomic = $0.030000 USDC per impression
- Hive take: 4,500 atomic per impression

---

## Integration Pattern: Embedding Ads in Hive Agents

This is the intended inline integration for `hive-discovery`, `hive-marketplace-agent`, and `hive-matchmaker`. Call `/v1/ad/decide` on any agent response that involves a tagged surface:

```js
// Example: hive-discovery calling hive-ad-bid inline
const adResponse = await fetch('https://hive-ad-bid.onrender.com/v1/ad/decide', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tag: 'compute',          // matches the discovery surface
    slot_count: 1,           // one sponsored slot
    query_did: requesterDID, // for attribution
    query_context: 'search', // optional context label
  }),
});
const { ad_slots } = await adResponse.json();

// Each slot contains: advertiser_did, headline, link, clearing_cpm_atomic, impression_id
// Render headline + link alongside organic results. The impression is already logged.
```

The impression is logged atomically on every `/v1/ad/decide` call. No secondary webhook needed. The advertiser's billing ledger is updated in real time.

---

## x402 Billing

Billing runs daily at **00:15 UTC**. The cron aggregates per-advertiser impression costs for the prior 24h.

To settle, the advertiser's hot wallet calls:

```
POST /v1/billing/sweep
Body: { "advertiser_did": "did:hive:0xabc..." }
```

Without `X-PAYMENT`, the endpoint returns **HTTP 402** with the full x402 challenge:

```json
{
  "error": "Payment Required",
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "chainId": 8453,
    "asset": "USDC",
    "maxAmountRequired": 1800000,
    "payTo": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
    "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "resource": "/v1/billing/sweep",
    "description": "Pay advertised impressions billed for the last 24h.",
    "mimeType": "application/json"
  }]
}
```

After 3 hours without payment (`grace` status), the advertiser is suspended and excluded from `/v1/ad/decide` results until settled.

---

## Impression Receipts and hive-attest-agentic-volume

Every impression receipt from `GET /v1/impressions/receipt/:impression_id` is signed with an ed25519 key (Spectral-style). The public key is advertised in `/.well-known/agent.json`.

This pairs with **hive-attest-agentic-volume** — receipts can be submitted to the attestation layer to prove real advertising volume for compliance and reporting purposes.

---

## Connect via MCP

```
https://hive-ad-bid.onrender.com/mcp
```

**Smithery:** `https://smithery.ai/server/srotzin/hive-ad-bid`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `IMPRESSION_HMAC_SECRET` | Yes | 32-byte base64 secret for HMAC signing impression records |
| `SPECTRAL_PRIVKEY_B64` | Yes | Ed25519 private key (PKCS8 DER, base64) for receipt signatures |
| `SPECTRAL_PUBKEY_B64` | Yes | Ed25519 public key (base64) advertised in agent.json |
| `PORT` | No | HTTP port (Render sets automatically) |

---

## License

MIT — © 2025 The Hivery
