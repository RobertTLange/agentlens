import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptRawArchive, encryptRawArchive } from "./archiveEncryption.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

describe("raw archive encryption", () => {
  it("encrypts raw provider bytes with a public key and restores them with its private key", () => {
    const source = Buffer.from('{"token":"do-not-store-in-canonical"}\n', "utf8");

    const encrypted = encryptRawArchive(source, keys.publicKey, "session-a:machine-a");

    expect(encrypted.ciphertext).not.toContain("do-not-store-in-canonical");
    expect(decryptRawArchive(encrypted, keys.privateKey, "session-a:machine-a")).toEqual(source);
  });

  it("rejects a tampered encrypted archive", () => {
    const encrypted = encryptRawArchive(Buffer.from("provider trace"), keys.publicKey, "session-a:machine-a");
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` };

    expect(() => decryptRawArchive(tampered, keys.privateKey, "session-a:machine-a")).toThrow();
  });

  it("rejects a raw archive replayed under another session context", () => {
    const encrypted = encryptRawArchive(Buffer.from("provider trace"), keys.publicKey, "session-a:machine-a");

    expect(() => decryptRawArchive(encrypted, keys.privateKey, "session-b:machine-a")).toThrow();
  });
});
