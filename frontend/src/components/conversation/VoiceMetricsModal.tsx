import { useEffect } from "react"
import { X } from "lucide-react"
import { MetricsResultView } from "@/components/MetricsResultView"
import type { MetricsResult } from "@/services/api"

interface Props {
  data: MetricsResult
  onClose: () => void
}

// Lightweight modal (no dialog primitive in the UI kit). Backdrop click + Esc close.
export function VoiceMetricsModal({ data, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h3 className="text-sm font-semibold">Voice Change Metrics</h3>
          <button
            onClick={onClose}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="px-5 pt-3 text-xs text-muted-foreground">
          Your original voice vs the converted voice PersonaPlex heard.
        </p>
        <div className="overflow-y-auto p-5 pt-3">
          <MetricsResultView data={data} />
        </div>
      </div>
    </div>
  )
}
