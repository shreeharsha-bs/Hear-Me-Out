import { useState, useRef, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useMeanVCPipeline } from "@/hooks/useMeanVCPipeline"
import { useConversation } from "@/hooks/useConversation"
import { ControlPanel } from "@/components/conversation/ControlPanel"
import { MessageFeed } from "@/components/conversation/MessageFeed"
import { DownloadBar } from "@/components/conversation/DownloadBar"
import type { useWebSocket } from "@/hooks/useWebSocket"
import type { useRecorder } from "@/hooks/useRecorder"

type WsState = ReturnType<typeof useWebSocket>
type RecorderState = ReturnType<typeof useRecorder>

interface Props {
  ws: WsState
  recorder: RecorderState
}

export function ConversationView({ ws, recorder }: Props) {
  const [meanvcSteps, setMeanvcSteps] = useState(8)
  const vcPipeline = useMeanVCPipeline((data) => ws.sendRawAudio(data), meanvcSteps)

  const {
    textPrompt, setTextPrompt,
    diarized, userWavUrl, personaplexWavUrl, mergedWavUrl,
    startConversation, stopConversation, downloadTranscript,
  } = useConversation(ws, recorder, vcPipeline)

  const [playing, setPlaying] = useState(false)
  const [playTime, setPlayTime] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const isConnected = ws.connected
  const isWarming = isConnected && !ws.warmupComplete
  const hasError = !!ws.error
  const showResult = diarized !== null && !isConnected

  // Auto-scroll to active turn during playback
  useEffect(() => {
    if (!playing || !scrollRef.current) return
    const el = scrollRef.current.querySelector("[data-active-turn]")
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [playTime, playing])

  return (
    <div className="flex flex-col gap-4 md:grid md:grid-cols-[1fr_280px] md:gap-4 md:h-full pb-2">
      {showResult && (
        <DownloadBar
          userWavUrl={userWavUrl}
          personaplexWavUrl={personaplexWavUrl}
          mergedWavUrl={mergedWavUrl}
          onDownloadTranscript={downloadTranscript}
          onPlayTimeChange={setPlayTime}
          onPlayingChange={setPlaying}
        />
      )}

      <Card className="flex flex-col overflow-hidden h-full py-0">
        <CardContent className="flex flex-1 flex-col p-0 overflow-y-auto" role="status" aria-live="polite">
          <MessageFeed
            transcripts={ws.transcripts}
            partialTranscript={ws.partialTranscript}
            diarized={diarized}
            error={ws.error}
            isWarming={isWarming}
            showResult={showResult}
            playing={playing}
            playTime={playTime}
            onDismissError={ws.clearError}
            scrollRef={scrollRef}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4 order-first md:order-none">
        <Card className="py-0 overflow-visible">
          <CardContent className="p-0">
            <ControlPanel
              isConnected={isConnected}
              isWarming={isWarming}
              hasError={hasError}
              textPrompt={textPrompt}
              onTextPromptChange={setTextPrompt}
              onStart={startConversation}
              onStop={stopConversation}
              vcPipeline={vcPipeline}
              meanvcSteps={meanvcSteps}
              onMeanvcStepsChange={setMeanvcSteps}
            />
          </CardContent>
        </Card>

        <Card className="flex flex-1 flex-col overflow-visible py-0 min-h-[120px]">
          <CardContent className="flex flex-1 flex-col p-0">
            {ws.partialTranscript ? (
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
