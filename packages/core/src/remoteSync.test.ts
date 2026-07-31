import { describe, expect, it } from "vitest";
import { mergeConfig } from "./config.js";
import { validateRemoteArchiveConfig } from "./remoteSync.js";

describe("remote sync configuration", () => {
  it("requires an explicit encryption identity before enabling sync", () => {
    const config = mergeConfig({ remoteArchive: { enabled: true } });
    expect(() => validateRemoteArchiveConfig(config)).toThrow("namespace");
  });

  it("accepts a complete local archive configuration", () => {
    const config = mergeConfig({
      remoteArchive: { enabled: true, namespace: "personal", originId: "laptop", rawPublicKeyPath: "~/archive.pub" },
    });
    expect(() => validateRemoteArchiveConfig(config)).not.toThrow();
  });
});
