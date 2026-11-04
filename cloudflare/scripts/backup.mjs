import { constants, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseHistory } from '../../src/chat/history.ts';

export function backupPublicKey(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('History backups need an RSA public key of at least 2048 bits.');
  return key;
}

export function encryptHistory(history, pem) {
  const publicKey = backupPublicKey(pem);
  const secret = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(parseHistory(history)), 'utf8'), cipher.final()]);
  const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, secret);
  return JSON.stringify({ format: 'fourth-mirror-history-v1', cipher: 'aes-256-gcm', keyWrapping: 'rsa-oaep-sha256',
    wrappedKey: wrappedKey.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

export function decryptHistory(encoded, pem) {
  try {
    if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error();
    const envelope = JSON.parse(encoded);
    if (envelope.format !== 'fourth-mirror-history-v1' || envelope.cipher !== 'aes-256-gcm' || envelope.keyWrapping !== 'rsa-oaep-sha256' ||
      !['wrappedKey', 'iv', 'tag', 'data'].every(name => typeof envelope[name] === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope[name]))) throw new Error();
    const secret = privateDecrypt({ key: createPrivateKey(pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (secret.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return parseHistory(JSON.parse(plain.toString('utf8')));
  } catch { throw new Error('Could not decrypt or validate this history backup. Check the backup file and matching private key.'); }
}

export async function saveEncryptedHistory(file, history, publicKey) {
  const encoded = encryptHistory(history, publicKey);
  await mkdir(dirname(resolve(file)), { recursive: true, mode: 0o700 });
  await writeFile(resolve(file), encoded, { mode: 0o600, flag: 'wx' });
}
