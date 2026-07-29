"use client";

import { useEffect, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";
import { motion } from "motion/react";
import OAuthButtons, { safeCallbackUrl } from "@/components/OAuthButtons";
import { Mail, Lock, Loader2, ArrowRight } from "lucide-react";

export default function LoginPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "authenticated") {
      toast("👀 Already signed in — redirecting...");
      router.push(safeCallbackUrl());
    }
  }, [status, router]);

  const isPasswordInvalid = () => {
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
    return password.length > 0 && !passwordRegex.test(password);
  };

  const isFormInvalid = !email || !password || isPasswordInvalid();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const result = await signIn("credentials", {
      redirect: false,
      email,
      password,
    });

    setLoading(false);

    if (result?.ok && !result.error) {
      router.push(safeCallbackUrl());
    } else if (result?.error === "CredentialsSignin") {
      toast.error("Invalid email or password");
    } else {
      toast.error(result?.error || "Something went wrong");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-50 p-4">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md"
      >
        <div className="bg-neutral-900 border border-neutral-800 shadow-xl rounded-2xl p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold tracking-tight mb-2 text-white">
              Welcome back
            </h1>
            <p className="text-neutral-400 text-sm">Login to continue coding</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <label
                htmlFor="email"
                className="text-xs font-medium text-neutral-400 ml-1"
              >
                Email Address
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-4 w-4 text-neutral-500 group-focus-within:text-neutral-200 transition-colors" />
                </div>
                <input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-neutral-950 border border-neutral-800 rounded-xl focus:outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500 transition-all placeholder:text-neutral-600 text-sm"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="password"
                className="text-xs font-medium text-neutral-400 ml-1"
              >
                Password
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-4 w-4 text-neutral-500 group-focus-within:text-neutral-200 transition-colors" />
                </div>
                <input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`w-full pl-10 pr-4 py-2.5 bg-neutral-950 border rounded-xl focus:outline-none focus:ring-1 transition-all placeholder:text-neutral-600 text-sm ${
                    isPasswordInvalid()
                      ? "border-red-900/50 focus:border-red-500/50 focus:ring-red-900/20 text-red-200"
                      : "border-neutral-800 focus:border-neutral-500 focus:ring-neutral-500"
                  }`}
                  required
                />
              </div>
              {isPasswordInvalid() && (
                <p className="text-neutral-500 text-[10px] ml-1">
                  Min 8 chars, uppercase, lowercase, number & symbol required.
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isFormInvalid || loading}
              className={`w-full py-2.5 rounded-xl font-medium text-sm transition-all duration-200 flex items-center justify-center gap-2
                ${
                  isFormInvalid || loading
                    ? "bg-neutral-800 text-neutral-500 cursor-not-allowed border border-neutral-800"
                    : "bg-white text-black hover:bg-neutral-200 border border-white active:scale-[0.98]"
                }`}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  Login <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <OAuthButtons callbackUrl={safeCallbackUrl()} />

          <p className="text-center text-xs text-neutral-500 mt-8">
            Don&apos;t have an account?{" "}
            <Link
              href="/signup"
              className="text-neutral-300 hover:text-white hover:underline transition-colors"
            >
              Sign up
            </Link>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
