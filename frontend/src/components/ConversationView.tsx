import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Mic, MicOff, ChevronRight, MessageSquareText, AudioLines, AlertCircle, Download } from "lucide-react"
import { cn } from "@/lib/utils"
import { webmToWavBlob } from "@/lib/audio"
import type { useRecorder } from "@/hooks/useRecorder"
import type { useWebSocket } from "@/hooks/useWebSocket"
import { transcribeRecording } from "@/hooks/useWebSocket"

type WsState = ReturnType<typeof useWebSocket>
type RecorderState = ReturnType<typeof useRecorder>

interface Props {
  ws: WsState
  recorder: RecorderState
}

interface DiarizedTurn {
  speaker: "user" | "personaplex"
  text: string
  start: number
  end: number
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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

export function ConversationView({ ws, recorder }: Props) {
  const micClicked = useRef(false)
  const transcribed = useRef(false)
  const [diarized, setDiarized] = useState<DiarizedTurn[] | null>(null)
  const [userWavUrl, setUserWavUrl] = useState<string | null>(null)
  const [personaplexWavUrl, setPersonaplexWavUrl] = useState<string | null>(null)

  const startConversation = useCallback(() => {
    ws.clearTranscripts()
    ws.clearResponseChunks()
    ws.clearError()
    micClicked.current = true
    transcribed.current = false
    setDiarized(null)
    setUserWavUrl(null)
    setPersonaplexWavUrl(null)
    ws.connect()
  }, [ws])

  const stopConversation = useCallback(() => {
    recorder.stop()
    ws.disconnect()
    micClicked.current = false
  }, [recorder, ws])

  useEffect(() => {
    if (ws.handshakeReceived && micClicked.current && !recorder.isRecording) {
      recorder.start().catch(() => {
        ws.disconnect()
        micClicked.current = false
      })
    }
  }, [ws.handshakeReceived, recorder, ws])

  // On stop: transcribe user audio, merge with PersonaPlex, create diarized output
  useEffect(() => {
    if (
      recorder.recordingAvailable &&
      recorder.recordedChunks.length > 0 &&
      !transcribed.current
    ) {
      transcribed.current = true
      ;(async () => {
        try {
          // Transcribe user audio
          const result = await transcribeRecording(recorder.recordedChunks)
          const userSegments: DiarizedTurn[] = (result.segments || []).map(
            (s: { start: number; end: number; text: string }) => ({
              speaker: "user" as const,
              text: s.text,
              start: s.start,
              end: s.end,
            })
          )

          // PersonaPlex turns (estimate timestamps from conversation timeline)
          const convStart = ws.transcripts[0]?.timestamp ?? Date.now()
          const pplxTurns: DiarizedTurn[] = ws.transcripts.map((t, i, arr) => {
            const prevEnd = i > 0 ? (arr[i - 1].timestamp - convStart) / 1000 : 0
            const start = Math.max(prevEnd, (t.timestamp - convStart) / 1000 - 2)
            return {
              speaker: "personaplex" as const,
              text: t.text,
              start,
              end: start + 2,
            }
          })

          // Merge and sort by start time
          const merged = [...userSegments, ...pplxTurns].sort(
            (a, b) => a.start - b.start
          )
          setDiarized(merged)

          // Add user transcripts to display
          for (const seg of userSegments) {
            ws.addUserTranscript(seg.text)
          }

          // Create audio download URLs
          if (recorder.recordedChunks.length > 0) {
            const wav = await webmToWavBlob(recorder.recordedChunks)
            setUserWavUrl(URL.createObjectURL(wav))
          }
          const pplxWav = await ws.getPersonaplexWav()
          if (pplxWav) {
            setPersonaplexWavUrl(URL.createObjectURL(pplxWav))
          }
        } catch (err) {
          console.error("Transcription failed:", err)
        }
      })()
    }
  }, [recorder.recordingAvailable])

  const dismissError = useCallback(() => {
    ws.clearError()
  }, [ws])

  const downloadTranscript = useCallback(() => {
    if (!diarized) return
    const lines = diarized.map(
      (t) => `[${formatTime(t.start)}-${formatTime(t.end)}] ${t.speaker === "user" ? "You" : "PersonaPlex"}: ${t.text}`
    )
    const blob = new Blob([lines.join("\n")], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "transcript.txt"
    a.click()
    URL.revokeObjectURL(url)
  }, [diarized])

  const isConnected = ws.connected
  const isWarming = isConnected && !ws.warmupComplete
  const hasMessages = ws.transcripts.length > 0 || !!ws.partialTranscript
  const hasError = !!ws.error
  const showResult = diarized !== null && !isConnected

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_320px] md:h-[calc(100vh-140px)]">
      {/* LEFT: Message feed */}
      <Card className="flex flex-col overflow-hidden min-h-0 h-full">
        <CardContent className="flex flex-1 flex-col p-0" role="status" aria-live="polite">
          {hasError && (
            <Alert variant="destructive" className="m-4">
              <AlertCircle />
              <div className="flex flex-1 flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Connection failed</span>
                  <Button variant="ghost" size="xs" onClick={dismissError} className="h-auto px-2 py-0.5 text-xs">
                    Dismiss
                  </Button>
                </div>
                <AlertDescription>{ws.error}</AlertDescription>
              </div>
            </Alert>
          )}

          {!hasMessages && !isWarming && !hasError && !showResult && (
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
                  <div key={i}>
                    <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground/60">
                      {t.speaker === "user" ? "You" : "PersonaPlex"}
                    </span>
                    <div className={cn(
                      "rounded-lg px-3.5 py-2.5",
                      t.speaker === "user" ? "bg-primary/10" : "bg-muted"
                    )}>
                      <p className="text-sm leading-relaxed">{t.text}</p>
                    </div>
                  </div>
                ))}
                {ws.partialTranscript && (
                  <div>
                    <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground/60">
                      PersonaPlex
                    </span>
                    <div className="rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-2.5">
                      <p className="text-sm leading-relaxed">{ws.partialTranscript}</p>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          )}

          {showResult && (
            <div className="flex flex-col gap-2 p-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Conversation complete</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="xs" onClick={downloadTranscript}>
                    <Download />Transcript
                  </Button>
                  {userWavUrl && (
                    <a
                      href={userWavUrl}
                      download="user-recording.wav"
                      className="inline-flex items-center gap-1 h-6 rounded-lg border px-2 text-xs font-medium hover:bg-muted"
                    >
                      <Download />Your audio
                    </a>
                  )}
                  {personaplexWavUrl && (
                    <a
                      href={personaplexWavUrl}
                      download="personaplex-response.wav"
                      className="inline-flex items-center gap-1 h-6 rounded-lg border px-2 text-xs font-medium hover:bg-muted"
                    >
                      <Download />PP audio
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* RIGHT: Controls column */}
      <div className="flex flex-col gap-4 order-first md:order-none">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 px-5 py-5">
            <div className="relative">
              {isConnected && (
                <div className="animate-pulse absolute inset-0 -m-2 rounded-full pointer-events-none shadow-[0_0_0_8px_rgba(239,68,68,0.15)]" />
              )}
              {hasError && !isConnected && (
                <div className="animate-pulse absolute inset-0 -m-2 rounded-full pointer-events-none shadow-[0_0_0_8px_rgba(239,68,68,0.12)]" />
              )}
              <Button
                variant={isConnected ? "destructive" : hasError ? "destructive" : "default"}
                onClick={isConnected ? stopConversation : startConversation}
                disabled={isWarming}
                className={cn(
                  "size-14 rounded-full",
                  isConnected && "bg-red-500 hover:bg-red-600 text-white border-0",
                  !isConnected && !hasError && !isWarming && "shadow-md shadow-primary/20"
                )}
                aria-label={isConnected ? "Stop recording" : "Start recording"}
              >
                {isWarming ? (
                  <Spinner className="text-primary-foreground" />
                ) : isConnected ? (
                  <MicOff />
                ) : (
                  <Mic />
                )}
              </Button>
            </div>

            {isConnected && !isWarming && (
              <div className="flex flex-col items-center gap-0.5 text-center">
                <p className="text-sm font-medium text-destructive">Recording…</p>
                <p className="text-xs text-muted-foreground">Tap to stop</p>
              </div>
            )}

            {isWarming && (
              <div className="flex flex-col items-center gap-0.5 text-center">
                <p className="text-sm font-medium">Connecting…</p>
                <p className="text-xs text-muted-foreground">Loading model, please wait</p>
              </div>
            )}

            {!isConnected && (
              <div className="flex flex-col items-center gap-0.5 text-center">
                <p className="text-sm font-medium">
                  {hasError ? "Connection error" : "Tap to start"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {hasError ? "Tap to retry" : "Press to begin speaking"}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <PipelinePill>Your voice</PipelinePill>
              <ChevronRight className="size-3 text-muted-foreground/50" />
              <PipelinePill>PersonaPlex</PipelinePill>
              <ChevronRight className="size-3 text-muted-foreground/50" />
              <PipelinePill>Response</PipelinePill>
            </div>

            <Badge variant={hasError ? "destructive" : isConnected ? "default" : "secondary"}>
              {hasError ? "Error" : isConnected ? "Connected" : "Ready"}
            </Badge>
          </CardContent>
        </Card>

        <Card className="flex flex-1 flex-col overflow-hidden min-h-0 h-full">
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