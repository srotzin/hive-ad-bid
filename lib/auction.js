/**
 * lib/auction.js
 * Second-price sealed-bid auction engine for hive-ad-bid.
 *
 * Rules:
 * - Top N bids by max_cpm_atomic win the N slots.
 * - Each winner pays the (N+1)th-highest bid (second-price / Vickrey logic extended to N slots).
 * - If fewer than N+1 bids exist, winners pay the reserve floor for their tag tier.
 * - Expired bids are excluded. Suspended advertisers are excluded.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG_TIERS = JSON.parse(
  readFileSync(join(__dirname, '../data/tag_tiers.json'), 'utf8')
);

/**
 * Resolve the tier and floor for a given tag string.
 * Priority: trophy > premium > common > commodity.
 * Unknown tags default to commodity.
 */
export function resolveTagTier(tag) {
  const t = (tag || '').toLowerCase().trim();
  const order = ['trophy', 'premium', 'common', 'commodity'];
  for (const tier of order) {
    const entry = TAG_TIERS.tiers[tier];
    if (entry.tags.includes(t)) {
      return { tier, floor_atomic: entry.floor_atomic, floor_usdc: entry.floor_usdc };
    }
  }
  // default
  const commodity = TAG_TIERS.tiers.commodity;
  return { tier: 'commodity', floor_atomic: commodity.floor_atomic, floor_usdc: commodity.floor_usdc };
}

/**
 * Run a second-price sealed-bid auction.
 *
 * @param {Array} activeBids - Array of bid objects with {bid_id, advertiser_did, tag, headline, link, max_cpm_atomic, daily_cap_atomic, expires_at}
 * @param {string} tag - The ad slot tag
 * @param {number} slotCount - Number of slots to fill
 * @param {Set} suspendedDIDs - Set of suspended advertiser DIDs
 * @returns {Array} winners - Array of {bid_id, advertiser_did, headline, link, clearing_cpm_atomic, rank}
 */
export function runAuction(activeBids, tag, slotCount, suspendedDIDs = new Set()) {
  const { floor_atomic } = resolveTagTier(tag);
  const now = Date.now();

  // Filter: same tag (or no tag filter), not expired, not suspended, meets floor
  const eligible = activeBids.filter(b => {
    if (b.tag !== tag) return false;
    if (new Date(b.expires_at).getTime() < now) return false;
    if (suspendedDIDs.has(b.advertiser_did)) return false;
    if (b.max_cpm_atomic < floor_atomic) return false;
    return true;
  });

  // Sort descending by max_cpm_atomic
  eligible.sort((a, b) => b.max_cpm_atomic - a.max_cpm_atomic);

  // Select top N winners
  const winners = eligible.slice(0, slotCount);

  // The price each winner pays = bid at position (N+1), or floor if not enough bidders
  const marginalBid = eligible[slotCount]; // (N+1)th bid, 0-indexed
  const clearingPrice = marginalBid ? marginalBid.max_cpm_atomic : floor_atomic;

  return winners.map((bid, idx) => ({
    bid_id: bid.bid_id,
    advertiser_did: bid.advertiser_did,
    headline: bid.headline,
    link: bid.link,
    clearing_cpm_atomic: clearingPrice,
    rank: idx + 1,
    tag: bid.tag,
  }));
}

/**
 * The Hive take rate.
 */
export const HIVE_TAKE_PCT = 15;

/**
 * Compute the amount owed to Hive for a single impression at clearing_cpm_atomic.
 * clearing_cpm_atomic is per-1000 impressions; one impression = clearing_cpm_atomic / 1000.
 * Hive takes 15%.
 */
export function hiveShareAtomic(clearing_cpm_atomic) {
  return Math.floor((clearing_cpm_atomic / 1000) * (HIVE_TAKE_PCT / 100));
}

/**
 * Total cost per impression to the advertiser (full CPM/1000, not just Hive share).
 * Billing charges the full clearing CPM/1000; Hive retains 15%.
 */
export function impressionCostAtomic(clearing_cpm_atomic) {
  return Math.floor(clearing_cpm_atomic / 1000);
}
