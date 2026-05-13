import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { audit } from "@/lib/security/auditLog";

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function getAllowedEmails(): string[] {
  return parseList(process.env.ALLOWED_EMAILS);
}

function getAllowedDomains(): string[] {
  return parseList(process.env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ""));
}

function isEmailAllowed(rawEmail: string | undefined | null): boolean {
  const email = (rawEmail ?? "").toLowerCase().trim();
  if (!email || !email.includes("@")) return false;
  const allowEmails = getAllowedEmails();
  if (allowEmails.includes(email)) return true;
  const domain = email.split("@")[1] ?? "";
  const allowDomains = getAllowedDomains();
  if (allowDomains.length > 0 && allowDomains.includes(domain)) return true;
  return false;
}

function extractEmail(user: { email?: string | null } | undefined, profile: unknown): string | null {
  if (user?.email) return user.email;
  if (profile && typeof profile === "object" && "email" in profile) {
    const e = (profile as { email?: unknown }).email;
    if (typeof e === "string") return e;
  }
  return null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!
    })
  ],
  session: {
    strategy: "jwt",
    // 24h — shorter for public multi-tenant tool (smaller window if cookie steals).
    maxAge: Math.max(60, Number(process.env.SESSION_MAXAGE_SEC ?? 24 * 60 * 60))
  },
  trustHost: process.env.AUTH_TRUST_HOST === "true",
  callbacks: {
    async signIn({ user, profile }) {
      const allowEmails = getAllowedEmails();
      const allowDomains = getAllowedDomains();
      const email = extractEmail(user, profile);
      // Fail-closed: if no allowlist is configured, only allow when AUTH_ALLOW_ANY=true.
      const allowed =
        allowEmails.length === 0 && allowDomains.length === 0
          ? process.env.AUTH_ALLOW_ANY === "true"
          : isEmailAllowed(email);
      if (!allowed) {
        audit({ action: "auth.signIn", email: email ?? undefined, ok: false, errCode: "EMAIL_NOT_ALLOWED" });
      }
      return allowed;
    }
  },
  events: {
    async signIn(message) {
      const email = extractEmail(message.user, message.profile);
      audit({ action: "auth.signIn", email: email ?? undefined, ok: true });
    },
    async signOut(message) {
      const email =
        "token" in message && message.token && typeof message.token.email === "string"
          ? message.token.email
          : undefined;
      audit({ action: "auth.signOut", email, ok: true });
    }
  }
});
