/**
 * lib/billing.js
 * Daily billing aggregation and settlement state for hive-ad-bid.
 *
 * Billing windows: 00:15 UTC daily cron aggregates impressions from the prior 24h.
 * Settlement: advertisers call POST /v1/billing/sweep with X-PAYMENT (x402 USDC on Base).
 * Storage: /tmp/ad_billing_settlements.jsonl for settlements; in-memory grace state.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { readAllImpressions } from './ledger.js';

const SETTLEMENTS_PATH = '/tmp/ad_billing_settlements.jsonl';

// Grace period after billing window opens before suspension.
export const GRACE_MS = 3 * 60 * 60 * 1000; // 3 hours

// In-memory billing state: Map<advertiser_did, {owed_atomic, window_opened_at, status}>
const billingState = new Map();

/**
 * Read all recorded settlements from disk.
 */
export function readSettlements() {
  if (!existsSync(SETTLEMENTS_PATH)) return [];
  const raw = readFileSync(SETTLEMENTS_PATH, 'utf8');
  return raw.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Run the daily billing aggregation.
 * Called by cron at 00:15 UTC.
 * Computes per-advertiser impression costs for the last 24h and
 * sets billing windows for any advertiser with owed > 0.
 */
export function runDailyAggregation() {
  const all = readAllImpressions();
  const now = Date.now();
  const ms24h = 24 * 60 * 60 * 1000;
  const recent = all.filter(r => now - new Date(r.logged_at).getTime() < ms24h);

  // Aggregate by advertiser_did
  const byDID = {};
  for (const r of recent) {
    if (!byDID[r.advertiser_did]) byDID[r.advertiser_did] = 0;
    byDID[r.advertiser_did] += (r.cost_atomic || 0);
  }

  const windowOpenedAt = new Date().toISOString();
  for (const [did, owed] of Object.entries(byDID)) {
    if (owed <= 0) continue;
    const existing = billingState.get(did) || {};
    billingState.set(did, {
      owed_atomic: (existing.owed_atomic || 0) + owed,
      window_opened_at: existing.window_opened_at || windowOpenedAt,
      status: existing.status || 'active',
      last_paid_at: existing.last_paid_at || null,
    });
  }

  return byDID;
}

/**
 * Compute total owed for a given advertiser DID based on all unpaid impressions.
 * This queries live ledger state for real-time display.
 */
export function computeOwed(advertiser_did) {
  const settlements = readSettlements();
  const paid = settlements.filter(s => s.advertiser_did === advertiser_did);
  const totalPaidAtomic = paid.reduce((s, r) => s + (r.amount_paid_atomic || 0), 0);

  const all = readAllImpressions();
  const totalOwed = all
    .filter(r => r.advertiser_did === advertiser_did)
    .reduce((s, r) => s + (r.cost_atomic || 0), 0);

  const netOwedAtomic = Math.max(0, totalOwed - totalPaidAtomic);
  return {
    advertiser_did,
    total_impressed_atomic: totalOwed,
    total_paid_atomic: totalPaidAtomic,
    net_owed_atomic: netOwedAtomic,
    net_owed_usdc: (netOwedAtomic / 1e6).toFixed(6),
  };
}

/**
 * Record a successful payment settlement.
 */
export function recordSettlement(advertiser_did, amount_paid_atomic, payment_header, tx_ref) {
  const entry = {
    advertiser_did,
    amount_paid_atomic,
    paid_at: new Date().toISOString(),
    tx_ref,
    payment_header_preview: payment_header ? payment_header.slice(0, 80) : null,
  };
  appendFileSync(SETTLEMENTS_PATH, JSON.stringify(entry) + '\n', 'utf8');

  // Update in-memory state
  const existing = billingState.get(advertiser_did) || {};
  const remainingOwed = Math.max(0, (existing.owed_atomic || 0) - amount_paid_atomic);
  billingState.set(advertiser_did, {
    ...existing,
    owed_atomic: remainingOwed,
    status: 'active',
    last_paid_at: new Date().toISOString(),
    window_opened_at: remainingOwed > 0 ? existing.window_opened_at : null,
  });

  return entry;
}

/**
 * Get billing health for an advertiser DID.
 */
export function getBillingHealth(advertiser_did) {
  const owed = computeOwed(advertiser_did);
  const state = billingState.get(advertiser_did);
  const now = Date.now();

  let status = 'active';
  let grace_expires_at = null;

  if (state && state.owed_atomic > 0) {
    const windowOpened = state.window_opened_at ? new Date(state.window_opened_at).getTime() : null;
    if (windowOpened) {
      const graceExpires = windowOpened + GRACE_MS;
      grace_expires_at = new Date(graceExpires).toISOString();
      if (now < graceExpires) {
        status = 'grace';
      } else {
        status = 'suspended';
        // Mark suspended in state
        billingState.set(advertiser_did, { ...state, status: 'suspended' });
      }
    }
  }

  return {
    advertiser_did,
    status,
    grace_expires_at,
    last_paid_at: state?.last_paid_at || null,
    net_owed_atomic: owed.net_owed_atomic,
    net_owed_usdc: owed.net_owed_usdc,
  };
}

/**
 * Check if a DID is suspended for use by the auction engine.
 */
export function isSuspended(advertiser_did) {
  const health = getBillingHealth(advertiser_did);
  return health.status === 'suspended';
}

/**
 * Export billing state map for external access (e.g. cron).
 */
export { billingState };
