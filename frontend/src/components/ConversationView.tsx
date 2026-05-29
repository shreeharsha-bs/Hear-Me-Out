import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Mic, MicOff, ChevronRight, MessageSquareText, AlertCircle, Download, Play, Pause } from "lucide-react"
import { cn } from "@/lib/utils"
import { webmToWavBlob, wavBlobToPcm, mergeFloat32s, createWavFile } from "@/lib/audio"
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
  const [mergedWavUrl, setMergedWavUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playTime, setPlayTime] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll to active turn during playback
  useEffect(() => {
    if (!playing || !scrollRef.current) return
    const el = scrollRef.current.querySelector("[data-active-turn]")
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [playTime, playing])

  const startConversation = useCallback(() => {
    ws.clearTranscripts()
    ws.clearResponseChunks()
    ws.clearError()
    micClicked.current = true
    transcribed.current = false
    setDiarized(null)
    setUserWavUrl(null)
    setPersonaplexWavUrl(null)
    setMergedWavUrl(null)
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

          // Reload transcript window with full diarized transcript
          ws.clearTranscripts()
          for (const turn of merged) {
            if (turn.speaker === "user") ws.addUserTranscript(turn.text)
          }

          if (recorder.recordedChunks.length > 0) {
            const userWav = await webmToWavBlob(recorder.recordedChunks)
            setUserWavUrl(URL.createObjectURL(userWav))
            const pplxWav = await ws.getPersonaplexWav()
            console.log("PersonaPlex WAV:", pplxWav ? `${pplxWav.size} bytes` : "null")
            if (pplxWav) {
              setPersonaplexWavUrl(URL.createObjectURL(pplxWav))
              try {
                const userPcm = await wavBlobToPcm(userWav)
                const pplxPcm = await wavBlobToPcm(pplxWav)
                const pplxStart = ws.getPersonaplexStartTime()
                // Align by timeline: user at t=0, silence gap, then PersonaPlex
                const userDuration = userPcm.length / 48000
                const gapDuration = Math.max(0, pplxStart - userDuration)
                const gapSamples = Math.floor(gapDuration * 48000)
                const silence = new Float32Array(gapSamples > 0 ? gapSamples : 0)
                const merged = createWavFile(mergeFloat32s([userPcm, silence, pplxPcm]), 48000)
                setMergedWavUrl(URL.createObjectURL(merged))
              } catch (e) { console.error("Merge failed:", e) }
            }
          }
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
    <div className="flex flex-col gap-4 md:grid md:grid-cols-[1fr_280px] md:gap-4 md:h-full pb-2">
      {/* Download bar — outside card */}
      {showResult && (
        <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/50 px-4 py-2">
          <span className="text-sm font-medium">Conversation complete</span>
          <div className="flex flex-wrap items-center gap-2">
            {mergedWavUrl && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  if (!audioRef.current) {
                    const a = new Audio(mergedWavUrl)
                    a.ontimeupdate = () => setPlayTime(a.currentTime)
                    a.onended = () => { setPlaying(false); setPlayTime(0) }
                    a.onplay = () => setPlaying(true)
                    a.onpause = () => setPlaying(false)
                    audioRef.current = a
                    a.play()
                  } else if (playing) {
                    audioRef.current.pause()
                  } else {
                    audioRef.current.play()
                  }
                }}
              >
                {playing ? <Pause /> : <Play />}
                {playing ? formatTime(playTime) : "Play"}
              </Button>
            )}
            <Button variant="outline" size="xs" onClick={downloadTranscript}>
              <Download /> Transcript
            </Button>
            <div className="flex gap-1">
              {userWavUrl && (
                <a href={userWavUrl} download="user-recording.wav"
                  className="inline-flex items-center gap-1 h-6 rounded-lg border px-2 text-[10px] font-medium hover:bg-muted">
                  You
                </a>
              )}
              {personaplexWavUrl && (
                <a href={personaplexWavUrl} download="personaplex-response.wav"
                  className="inline-flex items-center gap-1 h-6 rounded-lg border px-2 text-[10px] font-medium hover:bg-muted">
                  PP
                </a>
              )}
              {mergedWavUrl && (
                <a href={mergedWavUrl} download="conversation.wav"
                  className="inline-flex items-center gap-1 h-6 rounded-lg bg-primary px-2 text-[10px] font-medium text-primary-foreground hover:bg-primary/90">
                  All
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* LEFT: Message feed */}
      <Card className="flex flex-col overflow-hidden h-full py-0">
        <CardContent className="flex flex-1 flex-col p-0 overflow-y-auto" role="status" aria-live="polite" ref={scrollRef}>
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
                      <span className="text-muted-foreground/40 tabular-nums">
                        {formatTime(turn.start)}
                      </span>
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
        </CardContent>
      </Card>

      {/* RIGHT: Controls column */}
      <div className="flex flex-col gap-4 order-first md:order-none">
        <Card className="py-0 overflow-visible">
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

            <div className="flex flex-nowrap items-center justify-center gap-1">
              <PipelinePill>Your voice</PipelinePill>
              <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
              <PipelinePill>PersonaPlex</PipelinePill>
              <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
              <PipelinePill>Response</PipelinePill>
            </div>

            <Badge variant={hasError ? "destructive" : isConnected ? "default" : "secondary"} className="text-[10px]">
              {hasError ? "Error" : isConnected ? "Connected" : "Ready"}
            </Badge>
          </CardContent>
        </Card>

        <Card className="flex flex-1 flex-col overflow-visible py-0 min-h-[120px]">
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