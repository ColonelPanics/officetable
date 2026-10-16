// Secrets at rest (bank credentials). The app stores the bookie credentials it
// needs for transfers (player passwords, the house password, the service
// token). They must never sit in plaintext inside officetable.db — anyone with
// a copy of the database file must not inherit bank access.
//
// AES-256-GCM with a key derived from BANK_ENCRYPTION_KEY. If the env var is
// unset we derive a stable fallback from the bank URL so the app keeps
// working in dev, but a WARNING is logged: set the env var in production.
//
// Ciphertext is self-describing with an 'enc:v1:' marker so legacy plaintext
// values can be detected (and re-encrypted by the boot migration).

import crypto from 'crypto';
import db from './db';

const MARKER = 'enc:v1:';

function keyBytes(): Buffer {
  // Treat empty/whitespace values as unset (same rule as lib/alcesBank.ts).
  const bankKey = (process.env.BANK_ENCRYPTION_KEY ?? '').trim();
  const tokenKey = (process.env.ALCES_SERVICE_TOKEN ?? '').trim();
  const secret = bankKey || tokenKey; // last resort: same secret that the bank honours
  if (secret) return crypto.createHash('sha256').update(`officetable:${secret}`).digest();
  const baseUrl = process.env.ALCES_BANK_URL ?? 'http://10.151.0.85:3000/api/v1';
  console.warn(
    '[bank] BANK_ENCRYPTION_KEY is not set — bank credentials are encrypted with a derivable dev key. ' +
    'Set BANK_ENCRYPTION_KEY before this database leaves the machine.'
  );
  return crypto.createHash('sha256').update(`officetable:${baseUrl}:dev-key`).digest();
}

/** Encrypt a secret for storage. Returns 'enc:v1:<iv>:<tag>:<data>' (base64url parts). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MARKER + [iv, tag, data].map(b => b.toString('base64url')).join(':');
}

/**
 * Decrypt a stored secret. Legacy plaintext values (no marker) pass through
 * unchanged so pre-migration databases keep working; the boot migration in
 * lib/db.ts re-encrypts them on the next write path.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(MARKER)) return stored; // legacy plaintext
  const [ivB64, tagB64, dataB64] = stored.slice(MARKER.length).split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key (e.g. BANK_ENCRYPTION_KEY changed) — broken on purpose rather
    // than silently sending garbage credentials to the bank.
    throw new Error('Stored bank credentials cannot be decrypted — BANK_ENCRYPTION_KEY changed?');
  }
}

/** One-time boot migration: re-encrypt any legacy plaintext secrets in place. */
export function migratePlaintextSecrets(): void {
  try {
    const hasCol = db.prepare(
      `SELECT COUNT(*) as n FROM pragma_table_info('bank_accounts') WHERE name = 'bank_password'`
    ).get() as { n: number };
    if (hasCol.n > 0) {
      const rows = db.prepare(
        `SELECT player_id, bank_password FROM bank_accounts WHERE bank_password IS NOT NULL AND bank_password NOT LIKE 'enc:v1:%'`
      ).all() as { player_id: number; bank_password: string }[];
      const update = db.prepare(`UPDATE bank_accounts SET bank_password = ? WHERE player_id = ?`);
      for (const row of rows) update.run(encryptSecret(row.bank_password), row.player_id);
      if (rows.length) console.log(`[bank] re-encrypted ${rows.length} bank password(s) at rest`);
    }
    const settings = db.prepare(
      `SELECT key, value FROM settings WHERE key = 'alces_service_token' AND value NOT LIKE 'enc:v1:%'`
    ).all() as { key: string; value: string }[];
    const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
    for (const row of settings) upsert.run(row.key, encryptSecret(row.value));
    if (settings.length) console.log(`[bank] re-encrypted ${settings.length} setting secret(s) at rest`);
  } catch (e) {
    // Never block boot over a migration — reads still handle plaintext.
    console.error('[bank] secret migration skipped:', e);
  }
}