"use client";

import { useEffect, useState } from "react";
import { getProviders, signIn } from "next-auth/react";

const PROVIDERS = [
  { id: "google", label: "Google", icon: "/Google-icon.svg", iconClass: "opacity-80" },
  { id: "github", label: "GitHub", icon: "/Github-icon.svg", iconClass: "invert opacity-80" },
];

/** Renders only the OAuth providers configured on the server. */
export default function OAuthButtons({ callbackUrl = "/rooms" }: { callbackUrl?: string }) {
  const [available, setAvailable] = useState<string[] | null>(null);

  useEffect(() => {
    getProviders()
      .then((providers) => setAvailable(Object.keys(providers ?? {})))
      .catch(() => setAvailable([]));
  }, []);

  const shown = PROVIDERS.filter((p) => available?.includes(p.id));
  if (shown.length === 0) return null;

  return (
    <>
      <div className="relative my-8">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-neutral-800" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-neutral-900 px-2 text-neutral-500">Or continue with</span>
        </div>
      </div>

      <div className={`grid gap-4 ${shown.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        {shown.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => signIn(provider.id, { callbackUrl })}
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-neutral-950 border border-neutral-800 rounded-xl hover:bg-neutral-800 hover:text-white transition-all duration-200 active:scale-95"
          >
            <img src={provider.icon} alt={provider.label} className={`w-4 h-4 ${provider.iconClass}`} />
            <span className="text-sm font-medium text-neutral-400">{provider.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** Same-origin path from ?callbackUrl=, never an external URL. */
export function safeCallbackUrl(fallback = "/rooms"): string {
  if (typeof window === "undefined") return fallback;
  const value = new URLSearchParams(window.location.search).get("callbackUrl");
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}
