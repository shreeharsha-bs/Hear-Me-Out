import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { MessageSquareText, AlertCircle } from "lucide-react"
import { cn, formatTime } from "@/lib/utils"
import type { Transcript } from "@/hooks/useWebSocket"
import type { DiarizedTurn } from "@/hooks/useConversation"

interface Props {
  transcripts: Transcript[]
  partialTranscript: string
  diarized: DiarizedTurn[] | null
  error: string | null
  isWarming: boolean
  showResult: boolean
  playing: boolean
  playTime: number
  onDismissError: () => void
  scrollRef: React.RefObject<HTMLDivElement>
}

export function MessageFeed({
  transcripts, partialTranscript, diarized, error,
  isWarming, showResult, playing, playTime,
  onDismissError, scrollRef,
}: Props) {
  const hasMessages = transcripts.length > 0 || !!partialTranscript
  const hasError = !!error

  return (
    <div ref={scrollRef}>
      {hasError && (
        <Alert variant="destructive" className="m-3">
          <AlertCircle />
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Connection failed</span>
              <Button variant="ghost" size="xs" onClick={onDismissError} className="h-auto px-2 py-0.5 text-xs">
                Dismiss
              </Button>
            </div>
            <AlertDescription>{error}</AlertDescription>
          </div>
        </Alert>
      )}

      {!hasMessages && !isWarming && !hasError && !showResult && (
        <div className="flex flex-1 items-center justify-center p-4">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessageSquareText /></EmptyMedia>
              <EmptyTitle>Start a conversation</EmptyTitle>
              <EmptyDescription>Tap the mic to begin</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      )}

      {isWarming && (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <div className="flex items-center gap-2 pt-3 text-xs text-muted-foreground">
            <Spinner /> Warming up PersonaPlex…
          </div>
        </div>
      )}

      {hasMessages && !isWarming && !showResult && (
        <div className="p-4">
          {transcripts.map((t, i) => (
            <div key={i} className="mb-2">
              <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground/60">
                {t.speaker === "user" ? "You" : "PersonaPlex"}
              </span>
              <div className={cn("rounded-lg px-3.5 py-2.5", t.speaker === "user" ? "bg-primary/10" : "bg-muted")}>
                <p className="text-sm leading-relaxed">{t.text}</p>
              </div>
            </div>
          ))}
          {partialTranscript && (
            <div className="mb-2">
              <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground/60">PersonaPlex</span>
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-2.5">
                <p className="text-sm leading-relaxed">{partialTranscript}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {showResult && diarized && (
        <div className="p-4">
          {diarized.map((turn, i) => {
            const active = playing && playTime >= turn.start && playTime <= turn.end
            return (
              <div key={`d-${i}`} className="mb-2" data-active-turn={active ? "" : undefined}>
                <span className={cn(
                  "mb-0.5 flex items-center gap-1.5 text-[10px] font-medium",
                  active ? "text-primary" : "text-muted-foreground/60"
                )}>
                  <span className="text-muted-foreground/40 tabular-nums">{formatTime(turn.start)}</span>
                  {turn.speaker === "user" ? "You" : "PersonaPlex"}
                </span>
                <div className={cn(
                  "rounded-lg px-3.5 py-2.5 transition-colors",
                  active ? "ring-2 ring-primary ring-offset-1" : "",
                  turn.speaker === "user" ? "bg-primary/10" : "bg-muted"
                )}>
                  <p className="text-sm leading-relaxed">{turn.text}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
