import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Mic, MicOff, ChevronRight, MessageSquareText, AlertCircle, Download, Play, Pause, Wand2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { webmToWavBlob } from "@/lib/audio"
import type { useRecorder } from "@/hooks/useRecorder"
import type { useWebSocket } from "@/hooks/useWebSocket"
import { useMeanVCPipeline } from "@/hooks/useMeanVCPipeline"
import { transcribeRecording } from "@/hooks/useWebSocket"
import { Switch } from "@/components/ui/switch"

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

  const vcPipeline = useMeanVCPipeline(
    (data) => ws.sendAudio(data),
  )
  const { vcEnabled, vcTargetId, vcStreaming, startVCStream, stopVCStream: vcStop, getUserAudioWav } = vcPipeline
  const { isRecording, start: startRecorder } = recorder
  const [diarized, setDiarized] = useState<DiarizedTurn[] | null>(null)
  const [userWavUrl, setUserWavUrl] = useState<string | null>(null)
  const [personaplexWavUrl, setPersonaplexWavUrl] = useState<string | null>(null)
  const [mergedWavUrl, setMergedWavUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playTime, setPlayTime] = useState(0)
  const [duration, setDuration] = useState(0)
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
    const wasVC = vcStreaming
    if (vcStreaming) {
      vcStop()
    }
    recorder.stop()
    ws.disconnect()
    micClicked.current = false

    // If VC was active, process VC user audio for transcription and downloads
    if (wasVC) {
      console.log("[ConvVC] Processing VC audio for post-conversation UI...")
      ;(async () => {
        const vcWav = getUserAudioWav()
        console.log("[ConvVC] VC user audio WAV:", vcWav?.size, "bytes")
        if (!vcWav) return
        const vcUrl = URL.createObjectURL(vcWav)
        setUserWavUrl(vcUrl)
        // Get PersonaPlex WAV and merge with user audio
        let pplxWav: Blob | null = null;
        try {
          pplxWav = await ws.getPersonaplexWav()
          if (pplxWav) setPersonaplexWavUrl(URL.createObjectURL(pplxWav))
        } catch { /* ignore */ }
        // Merge user + PP audio
        if (vcWav && pplxWav) {
          try {
            const ctx = new AudioContext();
            const [userBuf, ppBuf] = await Promise.all([
              ctx.decodeAudioData(await vcWav.arrayBuffer()),
              ctx.decodeAudioData(await pplxWav.arrayBuffer()),
            ]);
            const maxLen = Math.max(userBuf.length, ppBuf.length);
            const merged = new Float32Array(maxLen);
            merged.set(userBuf.getChannelData(0), 0);
            for (let i = 0; i < ppBuf.length; i++) {
              merged[i] = Math.max(-1, Math.min(1, merged[i] + ppBuf.getChannelData(0)[i] * 0.8));
            }
            const int16 = new Int16Array(merged.length);
            for (let i = 0; i < merged.length; i++) {
              int16[i] = Math.max(-32768, Math.min(32767, merged[i] * 32767));
            }
            const wav = new ArrayBuffer(44 + int16.length * 2);
            const view = new DataView(wav);
            const ws = (o: number, s: string) => { for (let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
            ws(0, "RIFF"); view.setUint32(4, 36 + int16.length * 2, true);
            ws(8, "WAVE"); ws(12, "fmt "); view.setUint32(16, 16, true);
            view.setUint16(20, 1, true); view.setUint16(22, 1, true);
            view.setUint32(24, userBuf.sampleRate, true); view.setUint32(28, userBuf.sampleRate * 2, true);
            view.setUint16(32, 2, true); view.setUint16(34, 16, true);
            ws(36, "data"); view.setUint32(40, int16.length * 2, true);
            new Uint8Array(wav, 44).set(new Uint8Array(int16.buffer));
            setMergedWavUrl(URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
            ctx.close();
          } catch { setMergedWavUrl(vcUrl); }
        } else {
          setMergedWavUrl(vcUrl);
        }
        // Trigger transcription
        try {
          const result = await transcribeRecording([vcWav])
          const vcTurns: DiarizedTurn[] = (result.segments || []).map(
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
          setDiarized([...vcTurns, ...pplxTurns].sort((a, b) => a.start - b.start))
          console.log("[ConvVC] Diarized set:", vcTurns.length, "vc turns,", pplxTurns.length, "pplx turns")
        } catch (e) {
          console.error("VC transcription failed:", e)
          // Fallback: show downloads without transcript
          setDiarized([])
        }
      })()
    }
  }, [recorder, ws, vcStreaming, vcStop, getUserAudioWav])

  useEffect(() => {
    if (ws.handshakeReceived && micClicked.current && !isRecording && !vcStreaming) {
      if (vcEnabled && vcTargetId) {
        startVCStream().catch(() => {
          ws.disconnect()
          micClicked.current = false
        })
      } else {
        startRecorder().catch(() => {
          ws.disconnect()
          micClicked.current = false
        })
      }
    }
  }, [ws.handshakeReceived, isRecording, vcStreaming, vcEnabled, vcTargetId, startVCStream, startRecorder])

  // Route PersonaPlex playback into merged capture once recording starts
  useEffect(() => {
    if (recorder.isRecording && recorder.mergedContext && recorder.mergedDestination) {
      ws.setMergedOutput(recorder.mergedContext, recorder.mergedDestination)
    }
  }, [recorder.isRecording, recorder.mergedContext, recorder.mergedDestination, ws])

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
            if (pplxWav) setPersonaplexWavUrl(URL.createObjectURL(pplxWav))
            // Use the simultaneously-captured merged stream as "All" audio
            const mergedChunks = recorder.getMergedChunks()
            if (mergedChunks.length > 0) {
              try {
                const mergedWav = await webmToWavBlob(mergedChunks)
                setMergedWavUrl(URL.createObjectURL(mergedWav))
              } catch (e) { console.error("Merged audio conversion failed:", e) }
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
        <div className="md:col-span-2 rounded-lg border bg-muted/50 px-4 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Conversation complete</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="xs" onClick={downloadTranscript}>
                <Download /> Transcript
              </Button>
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
          {(mergedWavUrl || userWavUrl) && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => {
                  const src = mergedWavUrl || userWavUrl
                  if (!audioRef.current) {
                    const a = new Audio(src!)
                    a.ontimeupdate = () => setPlayTime(a.currentTime)
                    a.onloadedmetadata = () => setDuration(a.duration)
                    a.onended = () => { setPlaying(false); setPlayTime(0) }
                    a.onplay = () => setPlaying(true)
                    a.onpause = () => setPlaying(false)
                    audioRef.current = a
                    a.play()
                  } else if (playing) {
                    audioRef.current.pause()
                  } else {
                    if (audioRef.current.currentTime >= (audioRef.current.duration || 0) - 0.5) {
                      audioRef.current.currentTime = 0
                    }
                    audioRef.current.play()
                  }
                }}
              >
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              </Button>
              <div
                className="relative flex-1 h-1.5 rounded-full bg-muted-foreground/20 cursor-pointer"
                onClick={(e) => {
                  if (!audioRef.current) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pct = (e.clientX - rect.left) / rect.width
                  audioRef.current.currentTime = pct * (audioRef.current.duration || 0)
                  setPlayTime(audioRef.current.currentTime)
                }}
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-100"
                  style={{ width: `${duration > 0 ? (playTime / duration) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums min-w-[52px] text-right">
                {formatTime(playTime)} / {formatTime(duration)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* LEFT: Message feed */}
      <Card className="flex flex-col overflow-hidden h-full py-0">
        <CardContent className="flex flex-1 flex-col p-0 overflow-y-auto" role="status" aria-live="polite">
          <div ref={scrollRef}>
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
          </div>
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
              {vcPipeline.vcEnabled && vcPipeline.vcTargetId && (
                <>
                  <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
                  <PipelinePill>MeanVC</PipelinePill>
                </>
              )}
              <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
              <PipelinePill>PersonaPlex</PipelinePill>
              <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
              <PipelinePill>Response</PipelinePill>
            </div>

            {/* MeanVC Voice Conversion Pipeline */}
            <div className="w-full rounded-lg border border-purple-500/30 bg-purple-500/5 p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wand2 className="size-3.5 text-purple-400" />
                  <span className="text-xs font-medium text-purple-300">Voice Conversion</span>
                </div>
                <Switch checked={vcPipeline.vcEnabled} onCheckedChange={vcPipeline.setEnabled} />
              </div>
              {vcPipeline.vcEnabled && (
                <>
                  <input
                    type="file"
                    accept="audio/wav,.wav"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) vcPipeline.uploadTarget(f); }}
                    className="w-full text-[10px] text-muted-foreground file:mr-2 file:py-0.5 file:px-2 file:rounded file:bg-purple-600 file:text-white file:border-0 hover:file:bg-purple-500"
                  />
                  {vcPipeline.vcStatus && (
                    <p className={`text-[10px] ${vcPipeline.vcStatus.includes('Error') ? 'text-red-400' : 'text-green-400'}`}>
                      {vcPipeline.vcStatus}
                    </p>
                  )}
                </>
              )}
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