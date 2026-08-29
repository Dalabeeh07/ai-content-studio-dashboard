"use client";

import { useRef, useState, useTransition } from "react";
import { generateLicenses } from "@/app/licenses/actions";

function CopyableKey({ licenseKey }: { licenseKey: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(licenseKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <div className="flex items-center gap-3 bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-4 py-2.5">
      <code className="flex-1 font-mono text-sm text-brand-mint tracking-widest">
        {licenseKey}
      </code>
      <button
        onClick={copy}
        className="text-xs text-[#7070a0] hover:text-brand-blue transition-colors shrink-0"
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function GenerateForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [generatedKeys, setGeneratedKeys] = useState<string[]>([]);
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    setError("");

    startTransition(async () => {
      const result = await generateLicenses(fd);
      if (result.ok && result.keys) {
        setGeneratedKeys(result.keys);
        formRef.current?.reset();
      } else {
        setError(result.error ?? "Failed to generate keys.");
        setGeneratedKeys([]);
      }
    });
  }

  const inputCls =
    "w-full bg-[#0f0f1c] border border-[#1e1e38] rounded-lg px-3 py-2 text-sm text-[#e8e8f0]" +
    " placeholder-[#3a3a60] focus:outline-none focus:border-[#4a9eff] transition-colors";

  const Label = ({ children }: { children: React.ReactNode }) => (
    <label className="block text-[11px] font-semibold uppercase tracking-wide text-[#7070a0] mb-1.5">
      {children}
    </label>
  );

  return (
    <div className="bg-[#141428] border border-[#1e1e38] rounded-2xl p-6">
      <h2 className="text-[#e8e8f0] font-bold text-base mb-5">Generate New Licenses</h2>

      <form ref={formRef} onSubmit={handleSubmit}>
        <div className="grid grid-cols-2 gap-4">
          {/* Credits limit */}
          <div>
            <Label>Credits Limit</Label>
            <input
              type="number"
              name="credits_limit"
              defaultValue={50}
              min={1}
              max={10000}
              required
              className={inputCls}
            />
          </div>

          {/* Quantity */}
          <div>
            <Label>Quantity</Label>
            <input
              type="number"
              name="quantity"
              defaultValue={1}
              min={1}
              max={10}
              required
              className={inputCls}
            />
          </div>

          {/* User label */}
          <div>
            <Label>User Label <span className="normal-case font-normal text-[#3a3a60]">(optional)</span></Label>
            <input
              type="text"
              name="user_label"
              maxLength={80}
              placeholder="e.g. Ahmad, VIP User"
              className={inputCls}
            />
          </div>

          {/* Expires */}
          <div>
            <Label>Expires <span className="normal-case font-normal text-[#3a3a60]">(optional)</span></Label>
            <input
              type="date"
              name="expires"
              min={new Date().toISOString().slice(0, 10)}
              className={inputCls}
            />
          </div>
        </div>

        {error && (
          <p className="text-brand-orange text-xs mt-3">{error}</p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="mt-5 w-full py-2.5 rounded-xl text-sm font-bold text-white
                     bg-brand-blue hover:bg-[#6aadff] disabled:bg-[#3a3a60]
                     transition-colors"
        >
          {pending ? "Generating…" : "Generate Licenses"}
        </button>
      </form>

      {/* Generated keys output */}
      {generatedKeys.length > 0 && (
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-brand-mint text-xs font-semibold">
              ✓ {generatedKeys.length} key{generatedKeys.length > 1 ? "s" : ""} generated
            </p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(generatedKeys.join("\n"));
              }}
              className="text-xs text-[#7070a0] hover:text-brand-blue transition-colors"
            >
              Copy all
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {generatedKeys.map((k) => (
              <CopyableKey key={k} licenseKey={k} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
