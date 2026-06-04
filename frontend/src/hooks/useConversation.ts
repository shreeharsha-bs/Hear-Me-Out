import { useState, useRef, useCallback, useEffect } from "react"
import { webmToWavBlob } from "@/lib/audio"
import { transcribeRecording } from "@/services/api"
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

  const { vcEnabled, vcTargetId, vcStreaming, startVCStream, stopVCStream: vcStop, getUserAudioWav } = vcPipeline
  const { isRecording, start: startRecorder } = recorder

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
    ws.connect(textPrompt)
  }, [ws, textPrompt])

  const stopConversation = useCallback(() => {
    const wasVC = vcStreaming
    if (vcStreaming) vcStop()
    recorder.stop()
    ws.disconnect()
    micClicked.current = false

    if (wasVC) {
      ;(async () => {
        const vcWav = getUserAudioWav()
        if (!vcWav) return
        setUserWavUrl(URL.createObjectURL(vcWav))

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
        } catch {
          setDiarized([])
        }
      })()
    }
  }, [recorder, ws, vcStreaming, vcStop, getUserAudioWav])

  // Start recording after handshake
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
    startConversation,
    stopConversation,
    downloadTranscript,
  }
}
