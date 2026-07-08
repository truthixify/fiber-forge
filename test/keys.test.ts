import { describe, expect, it } from "vitest";
import { decryptKey, encryptKey, generatePrivateKey } from "../src/keys";

// A real fnn-produced key file (fiber tests/nodes/1/ckb/key, encrypted with "password1") and the
// private key it holds (tests/nodes/1/ckb/plain_key). Decrypting it proves our scrypt + AES-GCM
// parameters match fnn's exactly — if they did not, fnn could not read a key we write.
const REF_KEY_B64 =
  "AMTmrEITGrjdYWdpFokJ4Jh9WIBz4t+9kJ/9AQHfTIa9z0aJVkthCCMMJGyZUVy0uTMt90dd7OaxdM1m8saBNaKwgU8DRga0KKK+lCE=";
const REF_PLAIN_HEX =
  "cccd5f7e693b60447623fb71a5983f15a426938c33699b1a81d1239cfa656cd1";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("ckb key encryption", () => {
  it("decrypts a real fnn key to its known plaintext", () => {
    const file = new Uint8Array(Buffer.from(REF_KEY_B64, "base64"));
    expect(hex(decryptKey(file, "password1"))).toBe(REF_PLAIN_HEX);
  }, 20000);

  it("round-trips a generated key in fnn's file format", () => {
    const key = generatePrivateKey();
    expect(key.length).toBe(32);
    const file = encryptKey(key, "forge");
    expect(file[0]).toBe(0);
    expect(file.length).toBe(77);
    expect(hex(decryptKey(file, "forge"))).toBe(hex(key));
  }, 20000);

  it("rejects the wrong password", () => {
    const file = encryptKey(generatePrivateKey(), "right");
    expect(() => decryptKey(file, "wrong")).toThrow();
  }, 20000);
});
