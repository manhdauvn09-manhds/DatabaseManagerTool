"use client";

import { Suspense } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

function SignInInner() {
  const sp = useSearchParams();
  const next = sp.get("next") || "/app";

  return (
    <div className="w-full max-w-md rounded-2xl bg-white shadow-sm border border-zinc-200 p-6">
      <h1 className="text-2xl font-semibold">DatabaseManager</h1>
      <p className="mt-2 text-sm text-zinc-600">Bạn phải đăng nhập Google để sử dụng.</p>

      <button
        className="mt-6 w-full rounded-xl bg-zinc-900 text-white py-3 font-medium hover:bg-zinc-800"
        onClick={() => signIn("google", { callbackUrl: next })}
      >
        Sign in with Google
      </button>

      <p className="mt-4 text-xs text-zinc-500">
        Tip: Trong production, hãy deploy bằng HTTPS để bảo vệ toàn bộ traffic.
      </p>
    </div>
  );
}

export default function SignInPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <Suspense fallback={<div className="text-sm text-zinc-600">Loading…</div>}>
        <SignInInner />
      </Suspense>
    </main>
  );
}
