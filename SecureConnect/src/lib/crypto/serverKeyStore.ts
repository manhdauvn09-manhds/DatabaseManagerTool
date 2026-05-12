/**
 * Ephemeral RSA keypair for client-side encryption.
 *
 * Notes:
 * - This is a defense-in-depth layer on top of HTTPS.
 * - Keys are in-memory (ephemeral). Restart will rotate keys.
 * - For multi-instance production, consider stable KMS/HSM-managed keys.
 */

let cached:
  | {
      keyId: string;
      publicJwk: JsonWebKey;
      privateKey: CryptoKey;
    }
  | undefined;

function randomId() {
  return crypto.randomUUID();
}

export async function getOrCreateServerKey() {
  if (cached) return cached;

  const algo: RsaHashedKeyGenParams = {
    name: "RSA-OAEP",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  };

  const keyPair = (await crypto.subtle.generateKey(algo, true, ["encrypt", "decrypt"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

  cached = {
    keyId: randomId(),
    publicJwk,
    privateKey: keyPair.privateKey
  };

  return cached;
}

export async function decryptBase64RSAOAEP(ciphertextB64: string) {
  const { privateKey } = await getOrCreateServerKey();
  const bytes = Buffer.from(ciphertextB64, "base64");
  const plaintext = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, bytes);
  return new TextDecoder().decode(plaintext);
}
