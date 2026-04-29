/**
 * lib/ledger.js
 * Atomic-append HMAC-signed impression ledger.
 *
 * Storage: /data/impressions.jsonl inside the repo root at runtime.
 * Each line is a JSON object with an appended HMAC-SHA256 signature.
 *
 * Ed25519 receipt signatures use Node built-in crypto (generateKeyPairSync).
 */

import { createHmac, createSign, createVerify } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const LEDGER_PATH = join(DATA_DIR, 'impressions.jsonl');

// Ensure data dir exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const HMAC_SECRET = process.env.IMPRESSION_HMAC_SECRET || 'dev-hmac-secret-replace-in-prod';

// Ed25519 key loading from env or dev fallback
let SPECTRAL_PRIVKEY_DER = null;
let SPECTRAL_PUBKEY_B64 = process.env.SPECTRAL_PUBKEY_B64 || null;

function getPrivKey() {
  if (SPECTRAL_PRIVKEY_DER) return SPECTRAL_PRIVKEY_DER;
  const b64 = process.env.SPECTRAL_PRIVKEY_B64;
  if (b64) {
    SPECTRAL_PRIVKEY_DER = Buffer.from(b64, 'base64');
    return SPECTRAL_PRIVKEY_DER;
  }
  return null;
}

/**
 * Compute HMAC-SHA256 signature over a record object (sorted keys, JSON-serialised).
 */
function hmacSign(record) {
  const payload = JSON.stringify(record, Object.keys(record).sort());
  return createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

/**
 * Sign an impression receipt with the Spectral ed25519 private key.
 * Returns base64url signature string, or null if key not available.
 */
function ed25519Sign(payload) {
  const privKeyBuf = getPrivKey();
  if (!privKeyBuf) return null;
  try {
    const sign = createSign('ed25519');
    sign.update(JSON.stringify(payload));
    return sign.sign({ key: privKeyBuf, format: 'der', type: 'pkcs8' }, 'base64');
  } catch {
    return null;
  }
}

/**
 * Append one impression to the ledger.
 * Returns the complete signed record.
 */
export function appendImpression(impression) {
  const record = {
    ...impression,
    logged_at: new Date().toISOString(),
  };
  const hmac = hmacSign(record);
  const signedRecord = { ...record, _hmac: hmac };
  appendFileSync(LEDGER_PATH, JSON.stringify(signedRecord) + '\n', 'utf8');
  return signedRecord;
}

/**
 * Read all impressions from the ledger file.
 * Returns array of parsed records (including _hmac field).
 */
export function readAllImpressions() {
  if (!existsSync(LEDGER_PATH)) return [];
  const raw = readFileSync(LEDGER_PATH, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Compute audit summary for an advertiser DID.
 */
export function auditAdvertiser(advertiser_did) {
  const all = readAllImpressions();
  const mine = all.filter(r => r.advertiser_did === advertiser_did);
  const now = Date.now();
  const ms24h = 24 * 60 * 60 * 1000;
  const ms7d = 7 * 24 * 60 * 60 * 1000;

  const last24h = mine.filter(r => now - new Date(r.logged_at).getTime() < ms24h);
  const last7d = mine.filter(r => now - new Date(r.logged_at).getTime() < ms7d);

  const totalOwedAtomic = mine.reduce((s, r) => s + (r.cost_atomic || 0), 0);

  // Signed hash of total for verifiability
  const signedTotalHash = createHmac('sha256', HMAC_SECRET)
    .update(JSON.stringify({ advertiser_did, total_cpm_owed: totalOwedAtomic, count: mine.length }))
    .digest('hex');

  return {
    advertiser_did,
    count: mine.length,
    total_cpm_owed_atomic: totalOwedAtomic,
    total_cpm_owed_usdc: (totalOwedAtomic / 1e6).toFixed(6),
    last_24h_count: last24h.length,
    last_24h_owed_atomic: last24h.reduce((s, r) => s + (r.cost_atomic || 0), 0),
    last_7d_count: last7d.length,
    last_7d_owed_atomic: last7d.reduce((s, r) => s + (r.cost_atomic || 0), 0),
    signed_total_hash: signedTotalHash,
  };
}

/**
 * Get a single impression receipt by impression_id.
 * Includes ed25519 signature for hive-attest-agentic-volume compatibility.
 */
export function getReceipt(impression_id) {
  const all = readAllImpressions();
  const record = all.find(r => r.impression_id === impression_id);
  if (!record) return null;

  const receiptPayload = {
    impression_id: record.impression_id,
    advertiser_did: record.advertiser_did,
    tag: record.tag,
    clearing_cpm_atomic: record.clearing_cpm_atomic,
    cost_atomic: record.cost_atomic,
    logged_at: record.logged_at,
    hmac: record._hmac,
  };

  const signature = ed25519Sign(receiptPayload);
  return {
    ...receiptPayload,
    spectral_pubkey: SPECTRAL_PUBKEY_B64,
    ed25519_signature: signature,
    signature_scheme: 'ed25519',
    compatible_with: 'hive-attest-agentic-volume',
  };
}

export { SPECTRAL_PUBKEY_B64 };
