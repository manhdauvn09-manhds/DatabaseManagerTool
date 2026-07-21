import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";

const DNS_TIMEOUT_MS = 3000;

async function lookupWithTimeout(host: string): Promise<LookupAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS timeout")), DNS_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Always blocked — never legitimate for an external DB connection.
// Includes loopback, link-local (AWS/GCE metadata at 169.254.169.254), unspecified, multicast, reserved.
const FORBIDDEN_V4: Array<[number, number]> = [
  [0x7f000000, 8],   // 127.0.0.0/8 loopback
  [0xa9fe0000, 16],  // 169.254.0.0/16 link-local + cloud metadata
  [0x00000000, 8],   // 0.0.0.0/8
  [0xe0000000, 4],   // 224.0.0.0/4 multicast
  [0xf0000000, 4]    // 240.0.0.0/4 reserved
];

// RFC1918 — blocked unless caller passes { allowPrivate: true }.
const PRIVATE_V4: Array<[number, number]> = [
  [0x0a000000, 8],   // 10.0.0.0/8
  [0xac100000, 12],  // 172.16.0.0/12
  [0xc0a80000, 16]   // 192.168.0.0/16
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function matchAny(n: number, ranges: Array<[number, number]>): boolean {
  for (const [net, bits] of ranges) {
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
    if ((n & mask) === (net & mask)) return true;
  }
  return false;
}

export function isForbiddenIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return matchAny(n, FORBIDDEN_V4);
}

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return matchAny(n, PRIVATE_V4);
}

// Expand a compressed IPv6 address into 8 numeric groups.
// Returns null for malformed input.
function expandIPv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (s: string): number[] =>
    s === "" ? [] : s.split(":").map((g) => parseInt(g || "0", 16));
  if (halves.length === 1) {
    const parts = ip.split(":");
    if (parts.length !== 8) return null;
    return parts.map((g) => parseInt(g || "0", 16));
  }
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1]);
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...Array(fill).fill(0), ...right];
}

export function isForbiddenIPv6(ip: string): boolean {
  const l = ip.toLowerCase();
  // Fast path for canonical compressed forms.
  if (l === "::1" || l === "::") return true;
  if (l.startsWith("::ffff:")) {
    const v4 = l.slice("::ffff:".length);
    return isForbiddenIPv4(v4) || isPrivateIPv4(v4);
  }
  // C-4/S-4 fix: also catch expanded forms like 0:0:0:0:0:0:0:1.
  const groups = expandIPv6(l);
  if (!groups || groups.length !== 8) return false;
  const isLoopback = groups.every((g, i) => (i < 7 ? g === 0 : g === 1));
  const isUnspecified = groups.every((g) => g === 0);
  if (isLoopback || isUnspecified) return true;
  // Expanded IPv4-mapped: 0:0:0:0:0:ffff:x:x
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isForbiddenIPv4(v4) || isPrivateIPv4(v4);
  }
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const l = ip.toLowerCase();
  // fc00::/7 unique local
  if (/^f[cd]/.test(l)) return true;
  // fe80::/10 link-local
  if (/^fe[89ab]/.test(l)) return true;
  return false;
}

export type SafeHostResult =
  | { ok: true; ip: string }
  | { ok: false; reason: string };

export async function ensureSafeHost(
  host: string,
  opts: { allowPrivate?: boolean } = {}
): Promise<SafeHostResult> {
  if (!host || host.length > 253) return { ok: false, reason: "Invalid host" };

  const literal = isIP(host);
  if (literal === 4) {
    if (isForbiddenIPv4(host)) return { ok: false, reason: "Forbidden IPv4" };
    if (!opts.allowPrivate && isPrivateIPv4(host)) return { ok: false, reason: "Private IPv4 not allowed" };
    return { ok: true, ip: host };
  }
  if (literal === 6) {
    if (isForbiddenIPv6(host)) return { ok: false, reason: "Forbidden IPv6" };
    if (!opts.allowPrivate && isPrivateIPv6(host)) return { ok: false, reason: "Private IPv6 not allowed" };
    return { ok: true, ip: host };
  }

  // Hostname → resolve and check ALL returned addresses (defense against DNS rebinding-style answers).
  let results: LookupAddress[];
  try {
    results = await lookupWithTimeout(host);
  } catch {
    return { ok: false, reason: "DNS resolution failed or timed out" };
  }
  if (results.length === 0) {
    return { ok: false, reason: "Host did not resolve" };
  }
  for (const r of results) {
    if (r.family === 4) {
      if (isForbiddenIPv4(r.address)) return { ok: false, reason: `Resolves to forbidden ${r.address}` };
      if (!opts.allowPrivate && isPrivateIPv4(r.address)) return { ok: false, reason: `Resolves to private ${r.address}` };
    } else if (r.family === 6) {
      if (isForbiddenIPv6(r.address)) return { ok: false, reason: `Resolves to forbidden ${r.address}` };
      if (!opts.allowPrivate && isPrivateIPv6(r.address)) return { ok: false, reason: `Resolves to private ${r.address}` };
    }
  }
  return { ok: true, ip: results[0].address };
}
