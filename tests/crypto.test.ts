import { describe, expect, it } from 'vitest';
import { createCipher } from '@/src/adapters/storage/cipher';
import {
  generateApprovalToken,
  hashApprovalToken,
  isApprovalTokenFormatValid,
} from '@/src/core/tokens';
import { redact } from '@/src/core/errors';

const key = new Uint8Array(Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'));
const otherKey = new Uint8Array(Buffer.from('ffffffffffffffffffffffffffffffff', 'utf8'));

describe('token encryption at rest', () => {
  it('round-trips secrets with AES-GCM', async () => {
    const cipher = createCipher(key);
    const encrypted = await cipher.encrypt('ya29.super-secret-access-token');
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(encrypted).not.toContain('super-secret');
    await expect(cipher.decrypt(encrypted)).resolves.toBe('ya29.super-secret-access-token');
  });

  it('produces different ciphertext for the same plaintext (random IV)', async () => {
    const cipher = createCipher(key);
    const first = await cipher.encrypt('same-value');
    const second = await cipher.encrypt('same-value');
    expect(first).not.toBe(second);
  });

  it('fails closed when the key changed or the payload was tampered with', async () => {
    const encrypted = await createCipher(key).encrypt('refresh-token-value');
    await expect(createCipher(otherKey).decrypt(encrypted)).rejects.toThrow(
      /could not be decrypted/i,
    );
    const tampered = `${encrypted.slice(0, -4)}AAAA`;
    await expect(createCipher(key).decrypt(tampered)).rejects.toThrow();
  });
});

describe('approval tokens', () => {
  it('generates 256-bit URL-safe tokens', () => {
    const token = generateApprovalToken();
    expect(token).toHaveLength(43);
    expect(isApprovalTokenFormatValid(token)).toBe(true);
    expect(generateApprovalToken()).not.toBe(token);
  });

  it('rejects malformed tokens', () => {
    expect(isApprovalTokenFormatValid('short')).toBe(false);
    expect(isApprovalTokenFormatValid('a'.repeat(43))).toBe(true);
    expect(isApprovalTokenFormatValid('!'.repeat(43))).toBe(false);
  });

  it('hashes deterministically per secret and differently across secrets', async () => {
    const token = generateApprovalToken();
    const first = await hashApprovalToken(token, 'secret-one');
    const second = await hashApprovalToken(token, 'secret-one');
    const third = await hashApprovalToken(token, 'secret-two');
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('log redaction', () => {
  it('removes credentials from logged strings', () => {
    const message =
      'Authorization: Bearer ya29.abcdefghijklmnop failed for key AIzaSyABCDEFGHIJKLMNOP';
    const cleaned = redact(message);
    expect(cleaned).not.toContain('ya29.abcdefghijklmnop');
    expect(cleaned).not.toContain('AIzaSyABCDEFGHIJKLMNOP');
    expect(cleaned).toContain('[redacted]');
  });
});
