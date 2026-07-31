import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  KeyObject,
} from "node:crypto";

export const RAW_ARCHIVE_ENCRYPTION_ALGORITHM = "rsa-oaep-sha256";
const MAX_RAW_ARCHIVE_BYTES = 32 * 1024 * 1024;

export interface EncryptedRawArchive {
  schemaVersion: 1;
  contentEncryption: "aes-256-gcm";
  keyWrap: typeof RAW_ARCHIVE_ENCRYPTION_ALGORITHM;
  encryptedDataKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

type EncryptionKey = string | Buffer | KeyObject;

function rsaOptions(key: EncryptionKey): { key: EncryptionKey; padding: number; oaepHash: "sha256" } {
  return { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" };
}

function decode(value: string, label: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${label} must be base64`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxBytes) throw new Error(`${label} exceeds the raw archive size limit`);
  return decoded;
}

function rsaKeySize(key: EncryptionKey, operation: "public" | "private"): number {
  const parsed = key instanceof KeyObject ? key : operation === "public" ? createPublicKey(key) : createPrivateKey(key);
  if ((parsed.asymmetricKeyType !== "rsa" && parsed.asymmetricKeyType !== "rsa-pss") || !parsed.asymmetricKeyDetails?.modulusLength) {
    throw new Error("raw archive encryption requires an RSA key");
  }
  if (parsed.asymmetricKeyDetails.modulusLength < 2048) throw new Error("raw archive encryption requires an RSA key of at least 2048 bits");
  return parsed.asymmetricKeyDetails.modulusLength / 8;
}

function aad(context: string): Buffer {
  if (!context.trim()) throw new Error("raw archive encryption context is required");
  return Buffer.from(`agentlens.raw-archive.v1\u0000${context}`, "utf8");
}

export function encryptRawArchive(bytes: Uint8Array, publicKey: EncryptionKey, context: string): EncryptedRawArchive {
  if (bytes.byteLength > MAX_RAW_ARCHIVE_BYTES) throw new Error("raw archive exceeds the raw archive size limit");
  rsaKeySize(publicKey, "public");
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return {
      schemaVersion: 1,
      contentEncryption: "aes-256-gcm",
      keyWrap: RAW_ARCHIVE_ENCRYPTION_ALGORITHM,
      encryptedDataKey: publicEncrypt(rsaOptions(publicKey), dataKey).toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } finally {
    dataKey.fill(0);
  }
}

export function decryptRawArchive(archive: EncryptedRawArchive, privateKey: EncryptionKey, context: string): Buffer {
  if (archive.schemaVersion !== 1 || archive.contentEncryption !== "aes-256-gcm" || archive.keyWrap !== RAW_ARCHIVE_ENCRYPTION_ALGORITHM) {
    throw new Error("unsupported raw archive encryption envelope");
  }
  const wrappedKeySize = rsaKeySize(privateKey, "private");
  const encryptedDataKey = decode(archive.encryptedDataKey, "encrypted data key", wrappedKeySize);
  const iv = decode(archive.iv, "initialization vector", 12);
  const authTag = decode(archive.authTag, "authentication tag", 16);
  const ciphertext = decode(archive.ciphertext, "ciphertext", MAX_RAW_ARCHIVE_BYTES);
  if (encryptedDataKey.byteLength !== wrappedKeySize || iv.byteLength !== 12 || authTag.byteLength !== 16) {
    throw new Error("raw archive encryption envelope has invalid field sizes");
  }
  const dataKey = privateDecrypt(rsaOptions(privateKey), encryptedDataKey);
  if (dataKey.byteLength !== 32) throw new Error("raw archive encryption envelope has an invalid data key");
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
    decipher.setAAD(aad(context));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > MAX_RAW_ARCHIVE_BYTES) throw new Error("raw archive exceeds the raw archive size limit");
    return plaintext;
  } finally {
    dataKey.fill(0);
  }
}
