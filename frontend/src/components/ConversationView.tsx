import { useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Mic, MicOff, ChevronRight, MessageSquareText, AudioLines } from "lucide-react"
import { cn } from "@/lib/utils"
import type { useRecorder } from "@/hooks/useRecorder"
import type { useWebSocket } from "@/hooks/useWebSocket"

type WsState = ReturnType<typeof useWebSocket>
type RecorderState = ReturnType<typeof useRecorder>

interface Props {
  ws: WsState
  recorder: RecorderState
}

function PipelinePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  )
}

function WaveformBars() {
  return (
    <div className="flex items-end justify-center gap-1">
      {[14, 10, 16].map((h, i) => (
        <div
          key={i}
          className="w-1.5 rounded-full bg-muted-foreground/30"
          style={{
            height: `${h}px`,
            animation: "pulse 1.2s ease-in-out infinite",
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
    </div>
  )
}

export function ConversationView({ ws, recorder }: Props) {
  const startConversation = useCallback(() => {
    ws.clearTranscripts()
    ws.clearResponseChunks()
    ws.connect()
    recorder.start()
  }, [ws, recorder])

  const stopConversation = useCallback(() => {
    recorder.stop()
    ws.disconnect()
  }, [recorder, ws])

  const isConnected = ws.connected
  const isWarming = isConnected && !ws.warmupComplete
  const hasMessages = ws.transcripts.length > 0 || !!ws.partialTranscript

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_320px] md:h-[calc(100vh-140px)]">
      {/* LEFT: Message feed */}
      <Card className="flex flex-col overflow-hidden min-h-0">
        <CardContent className="flex flex-1 flex-col p-0" role="status" aria-live="polite">
          {!hasMessages && !isWarming && (
            <div className="flex flex-1 items-center justify-center p-6">
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessageSquareText />
                  </EmptyMedia>
                  <EmptyTitle>Your conversation will appear here</EmptyTitle>
                  <EmptyDescription>Tap the mic to start speaking.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          )}

          {isWarming && (
            <div className="flex flex-col gap-3 p-5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <div className="flex items-center gap-2 pt-3 text-xs text-muted-foreground">
                <Spinner />
                Warming up PersonaPlex…
              </div>
            </div>
          )}

          {hasMessages && !isWarming && (
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-2.5 p-5">
                {ws.transcripts.map((t, i) => (
                  <div key={i} className="rounded-lg bg-muted px-3.5 py-2.5">
                    <p className="text-sm leading-relaxed">{t.text}</p>
                  </div>
                ))}
                {ws.partialTranscript && (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-2.5">
                    <p className="text-sm leading-relaxed">{ws.partialTranscript}</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* RIGHT: Controls column */}
      <div className="flex flex-col gap-4 order-first md:order-none">
        {/* Mic card */}
        <Card>
          <CardContent className="flex flex-col items-center gap-4 px-5 py-5">
            <div className="relative">
              {isConnected && (
                <div className="animate-pulse absolute inset-0 -m-2 rounded-full shadow-[0_0_0_8px_rgba(16,185,129,0.12)]" />
              )}
              <Button
                variant={isConnected ? "destructive" : "default"}
                onClick={isConnected ? stopConversation : startConversation}
                className={cn(
                  "size-14 rounded-full",
                  !isConnected && "shadow-md shadow-primary/20"
                )}
                aria-label={isConnected ? "Stop recording" : "Start recording"}
              >
                {isConnected ? <MicOff /> : <Mic />}
              </Button>
            </div>

            <div className="flex flex-col items-center gap-0.5 text-center">
              <p className="text-sm font-medium">
                {isConnected ? "Recording…" : "Tap to start"}
              </p>
              <p className="text-xs text-muted-foreground">
                {isConnected ? "Speak naturally" : "Press to begin speaking"}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <PipelinePill>Your voice</PipelinePill>
              <ChevronRight className="size-3 text-muted-foreground/50" />
              <PipelinePill>PersonaPlex</PipelinePill>
              <ChevronRight className="size-3 text-muted-foreground/50" />
              <PipelinePill>Response</PipelinePill>
            </div>

            <Badge variant={isConnected ? "default" : "secondary"}>
              {isConnected ? "Connected" : "Ready"}
            </Badge>
          </CardContent>
        </Card>

        {/* Transcript card */}
        <Card className="flex flex-1 flex-col overflow-hidden min-h-0">
          <CardContent className="flex flex-1 flex-col p-0">
            {!hasMessages && !isWarming ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
                <WaveformBars />
                <p className="text-sm font-medium text-muted-foreground">
                  No transcript yet
                </p>
              </div>
            ) : ws.partialTranscript ? (
              <ScrollArea className="flex-1">
                <p className="p-4 text-sm leading-relaxed text-muted-foreground">
                  {ws.partialTranscript}
                </p>
              </ScrollArea>
            ) : (
              <div className="flex flex-1 items-center justify-center p-4">
                <Empty className="border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <AudioLines />
                    </EmptyMedia>
                    <EmptyTitle>No transcript yet</EmptyTitle>
                    <EmptyDescription>Tap the mic to start speaking.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}