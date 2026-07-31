import { compress, decompress, init } from "@bokuweb/zstd-wasm";

const ZSTD_COMPRESSION_LEVEL = 3;
export const MAX_ARCHIVE_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_DECOMPRESSED_BYTES = 16 * 1024 * 1024;
let initialization: Promise<void> | undefined;

function initializeZstd(): Promise<void> {
  initialization ??= init();
  return initialization;
}

export async function encodeZstd(bytes: Uint8Array): Promise<Uint8Array> {
  await initializeZstd();
  const encoded = compress(bytes, ZSTD_COMPRESSION_LEVEL);
  if (encoded.byteLength > MAX_ARCHIVE_CHUNK_BYTES) throw new Error("encoded archive chunk exceeds the archive chunk limit");
  return encoded;
}

export async function decodeZstd(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.byteLength > MAX_ARCHIVE_CHUNK_BYTES) throw new Error("encoded archive chunk exceeds the archive chunk limit");
  const expectedSize = zstdFrameContentSize(bytes);
  if (expectedSize > MAX_ARCHIVE_DECOMPRESSED_BYTES) throw new Error("decoded archive chunk exceeds the archive chunk limit");
  await initializeZstd();
  const decoded = decompress(bytes, { defaultHeapSize: MAX_ARCHIVE_DECOMPRESSED_BYTES });
  if (decoded.byteLength !== expectedSize) throw new Error("archive chunk did not decode to its declared size");
  return decoded;
}

function zstdFrameContentSize(bytes: Uint8Array): number {
  if (bytes.byteLength < 6 || bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd) {
    throw new Error("archive chunk is not a Zstandard frame");
  }

  const descriptor = bytes[4]!;
  if (descriptor & 0x08) throw new Error("archive chunk has a reserved Zstandard frame bit set");
  const singleSegment = Boolean(descriptor & 0x20);
  const dictionaryIdSize = [0, 1, 2, 4][descriptor & 0x03]!;
  const contentSizeFlag = descriptor >>> 6;
  const contentSizeLength = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  if (!contentSizeLength) throw new Error("archive chunk must declare its uncompressed size");

  const contentSizeOffset = 5 + (singleSegment ? 0 : 1) + dictionaryIdSize;
  if (contentSizeOffset + contentSizeLength > bytes.byteLength) throw new Error("archive chunk has a truncated Zstandard frame header");

  let contentSize = 0n;
  for (let index = 0; index < contentSizeLength; index += 1) {
    contentSize |= BigInt(bytes[contentSizeOffset + index]!) << BigInt(index * 8);
  }
  if (contentSizeFlag === 1) contentSize += 256n;
  if (contentSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("archive chunk declares an unsafe uncompressed size");
  return Number(contentSize);
}
