# hive-ad-bid v1.0.0

Initial release of the Hive IntraAgent Advertising Stack.

## What this is

`hive-ad-bid` is a single Node.js service implementing four modules that together form a complete agent advertising exchange:

| Module | Role |
|---|---|
| **ad-bid** | Second-price sealed-bid auction engine. Advertisers submit CPM bids with expiry and optional daily caps. |
| **ad-server** | `POST /v1/ad/decide` — runs the Vickrey auction for N slots on a given tag. SLO <50ms. |
| **impression-ledger** | Atomic-append HMAC-signed log at `/data/impressions.jsonl`. Ed25519 receipts compatible with hive-attest-agentic-volume. |
| **ad-billing** | Daily 00:15 UTC cron aggregates per-advertiser costs. Settles via x402 USDC on Base mainnet. 3h grace; auto-suspend on non-payment. |

## MCP Tools (5)

| Tool | Description |
|---|---|
| `bid` | Submit a CPM bid |
| `decide` | Run second-price auction |
| `audit_impressions` | Auditable impression summary |
| `billing_owed` | Current net owed |
| `billing_health` | Status: active / grace / suspended |

## Backend endpoints

| Path | Module |
|---|---|
| POST `/v1/ad/bid` | ad-bid |
| GET `/v1/ad/bid/:id` | ad-bid |
| POST `/v1/ad/bid/:id/cancel` | ad-bid |
| POST `/v1/ad/decide` | ad-server |
| GET `/v1/impressions/audit/:did` | impression-ledger |
| GET `/v1/impressions/receipt/:id` | impression-ledger |
| POST `/v1/billing/sweep` | ad-billing (402-gated) |
| GET `/v1/billing/owed/:did` | ad-billing |
| GET `/v1/billing/health/:did` | ad-billing |

## Pricing

- Hive take: **15%** of every cleared CPM
- Reserve floors: commodity $0.10 / common $1.00 / premium $5.00 / trophy $25.00
- Settlement: Base 8453, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Monroe: `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`

## Council provenance

Ad-hoc launch — highest-impact gap report surface. Revenue model: 15% take on cleared CPM volume. Projected at-saturation: $225K/day.

## Brand

`#C08D23` — Pantone 1245 C.

## Rails

Real rails only. Base mainnet USDC. No testnet, no simulation.
