import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Mic, MicOff, ChevronRight, MessageSquareText, AlertCircle, Download } from "lucide-react"
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

  useEffect(() => {
    if (
      recorder.recordingAvailable &&
      recorder.recordedChunks.length > 0 &&
      !transcribed.current
    ) {
      transcribed.current = true
      ;(async () => {
        try {
          const result = await transcribeRecording(recorder.recordedChunks)
          const userSegments: DiarizedTurn[] = (result.segments || []).map(
            (s: { start: number; end: number; text: string }) => ({
              speaker: "user" as const, text: s.text, start: s.start, end: s.end,
            })
          )
          const convStart = ws.transcripts[0]?.timestamp ?? Date.now()
          const pplxTurns: DiarizedTurn[] = ws.transcripts.map((t, i, arr) => {
            const prevEnd = i > 0 ? (arr[i - 1].timestamp - convStart) / 1000 : 0
            const start = Math.max(prevEnd, (t.timestamp - convStart) / 1000 - 2)
            return { speaker: "personaplex" as const, text: t.text, start, end: start + 2 }
          })
          const merged = [...userSegments, ...pplxTurns].sort((a, b) => a.start - b.start)
          setDiarized(merged)

          for (const seg of userSegments) ws.addUserTranscript(seg.text)

          if (recorder.recordedChunks.length > 0) {
            const wav = await webmToWavBlob(recorder.recordedChunks)
            setUserWavUrl(URL.createObjectURL(wav))
          }
          const pplxWav = await ws.getPersonaplexWav()
          if (pplxWav) setPersonaplexWavUrl(URL.createObjectURL(pplxWav))
        } catch (err) {
          console.error("Transcription failed:", err)
        }
      })()
    }
  }, [recorder.recordingAvailable])

  const dismissError = useCallback(() => ws.clearError(), [ws])

  const downloadTranscript = useCallback(() => {
    if (!diarized) return
    const lines = diarized.map(
      (t) => `[${formatTime(t.start)}-${formatTime(t.end)}] ${t.speaker === "user" ? "You" : "PersonaPlex"}: ${t.text}`
    )
    const blob = new Blob([lines.join("\n")], { type: "text/plain" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = "transcript.txt"
    a.click()
  }, [diarized])

  const isConnected = ws.connected
  const isWarming = isConnected && !ws.warmupComplete
  const hasMessages = ws.transcripts.length > 0 || !!ws.partialTranscript
  const hasError = !!ws.error
  const showResult = diarized !== null && !isConnected

  return (
    <div className="flex flex-col gap-4 md:grid md:grid-cols-[1fr_260px] md:gap-4 md:h-full md:overflow-hidden">
      {/* Download bar — outside card */}
      {showResult && (
        <div className="md:col-span-2 flex items-center justify-between rounded-lg border bg-muted/50 px-4 py-2">
          <span className="text-sm font-medium">Conversation complete</span>
          <div className="flex gap-2">
            <Button variant="outline" size="xs" onClick={downloadTranscript}>
              <Download /> Transcript
            </Button>
            {userWavUrl && (
              <a href={userWavUrl} download="user-recording.wav"
                className="inline-flex items-center gap-1 h-6 rounded-lg border px-2 text-xs font-medium hover:bg-muted">
                <Download /> Your audio
              </a>
            )}
            {personaplexWavUrl && (
              <a href={personaplexWavUrl} download="personaplex-response.wav"
                className="inline-flex items-center gap-1 h-6 rounded-lg border px-2 text-xs font-medium hover:bg-muted">
                <Download /> PP audio
              </a>
            )}
          </div>
        </div>
      )}

      {/* LEFT: Message feed */}
      <Card className="flex flex-col overflow-hidden min-h-0 h-full">
        <CardContent className="flex flex-1 flex-col p-0 overflow-y-auto" role="status" aria-live="polite">
          {hasError && (
            <Alert variant="destructive" className="m-3">
              <AlertCircle />
              <div className="flex flex-1 flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Connection failed</span>
                  <Button variant="ghost" size="xs" onClick={dismissError} className="h-auto px-2 py-0.5 text-xs">Dismiss</Button>
                </div>
                <AlertDescription>{ws.error}</AlertDescription>
              </div>
            </Alert>
          )}

          {!hasMessages && !isWarming && !hasError && (
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

          {hasMessages && !isWarming && (
            <div className="p-4">
              {ws.transcripts.map((t, i) => (
                <div key={i} className="mb-2">
                  <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground/60">
                    {t.speaker === "user" ? "You" : "PersonaPlex"}
                  </span>
                  <div className={cn("rounded-lg px-3.5 py-2.5", t.speaker === "user" ? "bg-primary/10" : "bg-muted")}>
                    <p className="text-sm leading-relaxed">{t.text}</p>
                  </div>
                </div>
              ))}
              {ws.partialTranscript && (
                <div className="mb-2">
                  <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground/60">PersonaPlex</span>
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-2.5">
                    <p className="text-sm leading-relaxed">{ws.partialTranscript}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* RIGHT: Controls column */}
      <div className="flex flex-col gap-4 order-first md:order-none">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 px-4 py-4">
            <div className="relative">
              {isConnected && (
                <div className="animate-pulse absolute inset-0 -m-1.5 rounded-full pointer-events-none shadow-[0_0_0_6px_rgba(239,68,68,0.15)]" />
              )}
              {hasError && !isConnected && (
                <div className="animate-pulse absolute inset-0 -m-1.5 rounded-full pointer-events-none shadow-[0_0_0_6px_rgba(239,68,68,0.12)]" />
              )}
              <Button
                variant={isConnected ? "destructive" : hasError ? "destructive" : "default"}
                onClick={isConnected ? stopConversation : startConversation}
                disabled={isWarming}
                className={cn("size-12 rounded-full", isConnected && "bg-red-500 hover:bg-red-600 text-white border-0", !isConnected && !hasError && !isWarming && "shadow-md shadow-primary/20")}
                aria-label={isConnected ? "Stop recording" : "Start recording"}
              >
                {isWarming ? <Spinner className="text-primary-foreground" /> : isConnected ? <MicOff /> : <Mic />}
              </Button>
            </div>

            {isConnected && !isWarming && (
              <div className="flex flex-col items-center gap-0.5 text-center">
                <p className="text-xs font-medium text-destructive">Recording…</p>
                <p className="text-[11px] text-muted-foreground">Tap to stop</p>
              </div>
            )}
            {isWarming && (
              <div className="flex flex-col items-center gap-0.5 text-center">
                <p className="text-xs font-medium">Connecting…</p>
                <p className="text-[11px] text-muted-foreground">Loading model</p>
              </div>
            )}
            {!isConnected && (
              <div className="flex flex-col items-center gap-0.5 text-center">
                <p className="text-xs font-medium">{hasError ? "Connection error" : "Tap to start"}</p>
                <p className="text-[11px] text-muted-foreground">{hasError ? "Tap to retry" : "Press to begin"}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-1">
              <PipelinePill>Your voice</PipelinePill>
              <ChevronRight className="size-2.5 text-muted-foreground/50" />
              <PipelinePill>PersonaPlex</PipelinePill>
              <ChevronRight className="size-2.5 text-muted-foreground/50" />
              <PipelinePill>Response</PipelinePill>
            </div>

            <Badge variant={hasError ? "destructive" : isConnected ? "default" : "secondary"} className="text-[10px]">
              {hasError ? "Error" : isConnected ? "Connected" : "Ready"}
            </Badge>
          </CardContent>
        </Card>

        <Card className="flex flex-1 flex-col overflow-hidden min-h-0 h-full">
          <CardContent className="flex flex-1 flex-col p-0">
            {!hasMessages && !isWarming ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
                <p className="text-xs text-muted-foreground">No transcript yet</p>
              </div>
            ) : ws.partialTranscript ? (
              <div className="flex-1 overflow-y-auto">
                <p className="p-4 text-sm leading-relaxed text-muted-foreground">{ws.partialTranscript}</p>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center p-4">
                <Empty className="border-0">
                  <EmptyHeader>
                    <EmptyTitle>No transcript yet</EmptyTitle>
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