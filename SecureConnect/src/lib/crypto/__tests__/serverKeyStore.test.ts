import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateServerKey, decryptBase64RSAOAEP, _resetServerKeyCache } from "../serverKeyStore";
import { _resetMasterKeyCache } from "../serverVault";

const MASTER = Buffer.alloc(32, 0x5a).toString("base64");

let tmpDir: string;
let origPath: string | undefined;
let origMaster: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "dbm-keypair-"));
  origPath = process.env.SERVER_KEYPAIR_PATH;
  origMaster = process.env.VAULT_MASTER_SECRET;
  process.env.SERVER_KEYPAIR_PATH = join(tmpDir, "kp.json");
  process.env.VAULT_MASTER_SECRET = MASTER;
  _resetMasterKeyCache();
  _resetServerKeyCache();
});

afterEach(async () => {
  if (origPath === undefined) delete process.env.SERVER_KEYPAIR_PATH; else process.env.SERVER_KEYPAIR_PATH = origPath;
  if (origMaster === undefined) delete process.env.VAULT_MASTER_SECRET; else process.env.VAULT_MASTER_SECRET = origMaster;
  _resetMasterKeyCache();
  _resetServerKeyCache();
  await rm(tmpDir, { recursive: true, force: true });
});

async function encryptWithPublic(publicJwk: JsonWebKey, plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(plaintext));
  return Buffer.from(new Uint8Array(ct)).toString("base64");
}

describe("serverKeyStore persistence", () => {
  test("keyId survives a simulated restart (persisted + reloaded)", async () => {
    const k1 = await getOrCreateServerKey();
    _resetServerKeyCache();           // simulate process restart
    const k2 = await getOrCreateServerKey();
    expect(k2.keyId).toBe(k1.keyId);  // same key, not rotated
  });

  test("password encrypted with old public key still decrypts after restart", async () => {
    const k1 = await getOrCreateServerKey();
    const ct = await encryptWithPublic(k1.publicJwk, "s3cr3t-pw");
    _resetServerKeyCache();
    const back = await decryptBase64RSAOAEP(ct);
    expect(back).toBe("s3cr3t-pw");
  });

  test("rotating master invalidates persisted key → regenerates fresh keyId", async () => {
    const k1 = await getOrCreateServerKey();
    _resetServerKeyCache();
    process.env.VAULT_MASTER_SECRET = Buffer.alloc(32, 0x99).toString("base64");
    _resetMasterKeyCache();
    const k2 = await getOrCreateServerKey();
    expect(k2.keyId).not.toBe(k1.keyId);
  });

  test("without VAULT_MASTER_SECRET → ephemeral (new keyId each init)", async () => {
    delete process.env.VAULT_MASTER_SECRET;
    _resetMasterKeyCache();
    _resetServerKeyCache();
    const k1 = await getOrCreateServerKey();
    _resetServerKeyCache();
    const k2 = await getOrCreateServerKey();
    expect(k2.keyId).not.toBe(k1.keyId);
  });
});
