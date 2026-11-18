import { AppError } from '@/src/core/errors';
import type { Cipher } from '@/src/core/ports';

const VERSION = 'v1';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * AES-256-GCM encryption for OAuth tokens at rest.
 * Key material comes from TOKEN_ENCRYPTION_KEY and never leaves the server.
 */
export function createCipher(keyBytes: Uint8Array): Cipher {
  if (keyBytes.length !== 32) {
    throw new AppError('CONFIG_ERROR', 'Token encryption key must be 32 bytes');
  }
  const rawKey: Uint8Array<ArrayBuffer> = new Uint8Array(keyBytes);
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = (): Promise<CryptoKey> => {
    keyPromise ??= crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    return keyPromise;
  };

  return {
    async encrypt(plaintext: string): Promise<string> {
      const key = await getKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(plaintext),
      );
      return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
    },

    async decrypt(payload: string): Promise<string> {
      const [version, ivB64, cipherB64] = payload.split('.');
      if (version !== VERSION || !ivB64 || !cipherB64) {
        throw new AppError(
          'INTEGRATION_ERROR',
          'Stored token is not in a readable format - reconnect the integration.',
        );
      }
      try {
        const key = await getKey();
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(ivB64) },
          key,
          fromBase64(cipherB64),
        );
        return new TextDecoder().decode(plaintext);
      } catch (error) {
        throw new AppError(
          'INTEGRATION_ERROR',
          'Stored token could not be decrypted (was TOKEN_ENCRYPTION_KEY changed?) - reconnect the integration.',
          { cause: error },
        );
      }
    },
  };
}
