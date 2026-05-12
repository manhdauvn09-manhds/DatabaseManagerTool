export type PublicKeyResponse = { keyId: string; publicJwk: JsonWebKey };

function bufToBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function encryptPasswordRSAOAEP(password: string, publicJwk: JsonWebKey) {
  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );

  const encoded = new TextEncoder().encode(password);
  const ciphertext = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, encoded);
  return bufToBase64(ciphertext);
}
