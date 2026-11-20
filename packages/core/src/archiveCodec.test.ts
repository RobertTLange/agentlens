import { describe, expect, it } from "vitest";
import { decodeZstd, encodeZstd, MAX_ARCHIVE_CHUNK_BYTES } from "./archiveCodec.js";

describe("archive codec", () => {
  it("round-trips UTF-8 trace data with Zstandard", async () => {
    const source = Buffer.from('{"message":"repeat repeat repeat"}\n'.repeat(500), "utf8");

    const compressed = await encodeZstd(source);
    const restored = await decodeZstd(compressed);

    expect(Buffer.from(restored)).toEqual(source);
    expect(compressed.byteLength).toBeLessThan(source.byteLength);
  });

  it("rejects chunks that exceed the archive safety limit before decoding", async () => {
    await expect(decodeZstd(new Uint8Array(MAX_ARCHIVE_CHUNK_BYTES + 1))).rejects.toThrow("archive chunk limit");
  });
});
