// Shimmer placeholder shown after a conversation ends while the transcript,
// WAVs and metrics are still being assembled (the real DownloadBar only mounts
// once those are ready).
export function DownloadBarSkeleton() {
  return (
    <div className="md:col-span-2 rounded-lg border bg-muted/50 px-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="h-4 w-40 rounded bg-muted shimmer" />
        <div className="flex items-center gap-2">
          <div className="h-6 w-20 rounded-lg bg-muted shimmer" />
          <div className="h-6 w-10 rounded-lg bg-muted shimmer" />
          <div className="h-6 w-10 rounded-lg bg-muted shimmer" />
          <div className="h-6 w-10 rounded-lg bg-muted shimmer" />
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="size-7 rounded-full bg-muted shimmer" />
        <div className="h-1.5 flex-1 rounded-full bg-muted shimmer" />
        <div className="h-3 w-12 rounded bg-muted shimmer" />
      </div>
    </div>
  )
}
