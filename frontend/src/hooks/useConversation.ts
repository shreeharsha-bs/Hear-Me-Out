import { useState, useRef, useCallback, useEffect } from "react"
import { webmToWavBlob } from "@/lib/audio"
import { transcribeRecording, transcribeWavBlob, compareMetricsData, type MetricsResult } from "@/services/api"
import { mergeAudioTracks } from "@/services/audioMerge"
import { formatTime } from "@/lib/utils"
import type { useWebSocket } from "@/hooks/useWebSocket"
import type { useRecorder } from "@/hooks/useRecorder"
import type { useMeanVCPipeline } from "@/hooks/useMeanVCPipeline"

type WsState = ReturnType<typeof useWebSocket>
type RecorderState = ReturnType<typeof useRecorder>
type VCState = ReturnType<typeof useMeanVCPipeline>

export interface DiarizedTurn {
  speaker: "user" | "personaplex"
  text: string
  start: number
  end: number
}

export function useConversation(ws: WsState, recorder: RecorderState, vcPipeline: VCState) {
  const micClicked = useRef(false)
  const transcribed = useRef(false)

  const [textPrompt, setTextPrompt] = useState("You enjoy having a good conversation.")
  const [diarized, setDiarized] = useState<DiarizedTurn[] | null>(null)
  const [userWavUrl, setUserWavUrl] = useState<string | null>(null)
  const [personaplexWavUrl, setPersonaplexWavUrl] = useState<string | null>(null)
  const [mergedWavUrl, setMergedWavUrl] = useState<string | null>(null)
  // Voice-change metrics (VC mode only): original mic vs converted voice.
  const [originalUserWavUrl, setOriginalUserWavUrl] = useState<string | null>(null)
  const [vcMetrics, setVcMetrics] = useState<MetricsResult | null>(null)
  const [vcMetricsLoading, setVcMetricsLoading] = useState(false)
  // True between conversation end and the results being ready (drives the shimmer).
  const [processing, setProcessing] = useState(false)

  const { vcEnabled, vcTargetId, vcStreaming, startMic, beginSending, stopVCStream: vcStop, getOriginalUserWav } = vcPipeline
  const { isRecording, start: startRecorder } = recorder
  const sendingBegun = useRef(false)

  const startConversation = useCallback(async () => {
    ws.clearTranscripts()
    ws.clearResponseChunks()
    ws.clearError()
    micClicked.current = true
    transcribed.current = false
    sendingBegun.current = false
    setDiarized(null)
    setUserWavUrl(null)
    setPersonaplexWavUrl(null)
    setMergedWavUrl(null)
    setOriginalUserWavUrl(null)
    setVcMetrics(null)
    setVcMetricsLoading(false)
    setProcessing(false)
    if (vcEnabled && vcTargetId) {
      // VC mode: acquire mic first to learn the sample rate, then connect to the
      // chat-proxy (which speaks PersonaPlex's protocol on this same socket).
      try {
        const proxy = await startMic()
        ws.connect(textPrompt, proxy)
      } catch {
        micClicked.current = false
      }
    } else {
      ws.connect(textPrompt)
    }
  }, [ws, textPrompt, vcEnabled, vcTargetId, startMic])

  const stopConversation = useCallback(() => {
    const wasVC = vcStreaming
    if (vcStreaming) vcStop()
    recorder.stop()
    ws.disconnect()
    micClicked.current = false
    setProcessing(true)

    if (wasVC) {
      ;(async () => {
        const vcWav = ws.getVcUserWav()
        if (!vcWav) { setProcessing(false); return }
        setUserWavUrl(URL.createObjectURL(vcWav))

        const originalWav = getOriginalUserWav()
        if (originalWav) setOriginalUserWavUrl(URL.createObjectURL(originalWav))

        let pplxWav: Blob | null = null
        try {
          pplxWav = await ws.getPersonaplexWav()
          if (pplxWav) setPersonaplexWavUrl(URL.createObjectURL(pplxWav))
        } catch { /* ignore */ }

        if (pplxWav) {
          try {
            setMergedWavUrl(URL.createObjectURL(await mergeAudioTracks(vcWav, pplxWav)))
          } catch { setMergedWavUrl(URL.createObjectURL(vcWav)) }
        } else {
          setMergedWavUrl(URL.createObjectURL(vcWav))
        }

        // Build PersonaPlex turns first so they survive even if the
        // converted-voice transcription below fails (long clips, etc).
        const convStart = ws.transcripts[0]?.timestamp ?? Date.now()
        const pplxTurns: DiarizedTurn[] = ws.transcripts.map((t, i, arr) => {
          const prevEnd = i > 0 ? (arr[i - 1].timestamp - convStart) / 1000 : 0
          const start = Math.max(prevEnd, (t.timestamp - convStart) / 1000 - 2)
          return { speaker: "personaplex" as const, text: t.text, start, end: start + 2 }
        })
        let vcTurns: DiarizedTurn[] = []
        try {
          const result = await transcribeWavBlob(vcWav)
          vcTurns = (result.segments || []).map(
            (s: { start: number; end: number; text: string }) => ({
              speaker: "user" as const, text: s.text, start: s.start, end: s.end,
            })
          )
        } catch (e) {
          console.error("Converted-voice transcription failed:", e)
        }
        setDiarized([...vcTurns, ...pplxTurns].sort((a, b) => a.start - b.start))

        // Voice-change metrics AFTER diarization finishes, so its GPU models
        // never run concurrently with the transcription above (the shared GPU
        // also holds PersonaPlex 7B — concurrency caused CUDA OOM).
        if (originalWav) {
          setVcMetricsLoading(true)
          compareMetricsData(originalWav, vcWav)
            .then(setVcMetrics)
            .catch(() => setVcMetrics(null))
            .finally(() => setVcMetricsLoading(false))
        }
      })()
    }
  }, [recorder, ws, vcStreaming, vcStop, getOriginalUserWav])

  // VC mode: once the proxy relays PersonaPlex's handshake, open the gate so mic
  // PCM starts flowing. (Mic was already acquired in startConversation.)
  useEffect(() => {
    if (ws.handshakeReceived && micClicked.current && vcStreaming && !sendingBegun.current) {
      sendingBegun.current = true
      beginSending()
    }
  }, [ws.handshakeReceived, vcStreaming, beginSending])

  // Non-VC mode: start recording after handshake
  useEffect(() => {
    if (ws.handshakeReceived && micClicked.current && !isRecording && !vcStreaming) {
      startRecorder().catch(() => {
        ws.disconnect()
        micClicked.current = false
      })
    }
  }, [ws.handshakeReceived, isRecording, vcStreaming, startRecorder])

  // Route PersonaPlex audio into merged capture
  useEffect(() => {
    if (recorder.isRecording && recorder.mergedContext && recorder.mergedDestination) {
      ws.setMergedOutput(recorder.mergedContext, recorder.mergedDestination)
    }
  }, [recorder.isRecording, recorder.mergedContext, recorder.mergedDestination, ws.setMergedOutput])

  // Post-recording transcription (non-VC path)
  useEffect(() => {
    if (!recorder.recordingAvailable || recorder.recordedChunks.length === 0 || transcribed.current) return
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
        const diarizedResult = [...userSegments, ...pplxTurns].sort((a, b) => a.start - b.start)
        setDiarized(diarizedResult)

        ws.clearTranscripts()
        for (const turn of diarizedResult) {
          if (turn.speaker === "user") ws.addUserTranscript(turn.text)
        }

        const userWav = await webmToWavBlob(recorder.recordedChunks)
        setUserWavUrl(URL.createObjectURL(userWav))

        const pplxWav = await ws.getPersonaplexWav()
        if (pplxWav) setPersonaplexWavUrl(URL.createObjectURL(pplxWav))

        const mergedChunks = recorder.getMergedChunks()
        if (mergedChunks.length > 0) {
          try {
            setMergedWavUrl(URL.createObjectURL(await webmToWavBlob(mergedChunks)))
          } catch (e) { console.error("Merged audio conversion failed:", e) }
        }
      } catch (err) {
        console.error("Transcription failed:", err)
      }
    })()
  }, [recorder.recordingAvailable])

  // Results are ready once diarization lands → drop the shimmer.
  useEffect(() => {
    if (diarized !== null) setProcessing(false)
  }, [diarized])

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

  return {
    textPrompt,
    setTextPrompt,
    diarized,
    userWavUrl,
    personaplexWavUrl,
    mergedWavUrl,
    originalUserWavUrl,
    vcMetrics,
    vcMetricsLoading,
    processing,
    startConversation,
    stopConversation,
    downloadTranscript,
  }
}
