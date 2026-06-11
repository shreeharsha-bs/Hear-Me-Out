import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Download, Play, Pause, BarChart3 } from "lucide-react"
import { formatTime } from "@/lib/utils"

interface Props {
  userWavUrl: string | null
  personaplexWavUrl: string | null
  mergedWavUrl: string | null
  originalUserWavUrl?: string | null
  onDownloadTranscript: () => void
  onPlayTimeChange: (t: number) => void
  onPlayingChange: (p: boolean) => void
  vcMetricsLoading?: boolean
  vcMetricsReady?: boolean
  onShowVcMetrics?: () => void
}

export function DownloadBar({
  userWavUrl, personaplexWavUrl, mergedWavUrl, originalUserWavUrl,
  onDownloadTranscript, onPlayTimeChange, onPlayingChange,
  vcMetricsLoading, vcMetricsReady, onShowVcMetrics,
}: Props) {
  const [playing, setPlaying] = useState(false)
  const [playTime, setPlayTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const updatePlaying = (p: boolean) => { setPlaying(p); onPlayingChange(p) }
  const updatePlayTime = (t: number) => { setPlayTime(t); onPlayTimeChange(t) }

  const togglePlay = () => {
    const src = mergedWavUrl || userWavUrl
    if (!audioRef.current) {
      const a = new Audio(src!)
      a.ontimeupdate = () => updatePlayTime(a.currentTime)
      a.onloadedmetadata = () => setDuration(a.duration)
      a.onended = () => { updatePlaying(false); updatePlayTime(0) }
      a.onplay = () => updatePlaying(true)
      a.onpause = () => updatePlaying(false)
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
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    audioRef.current.currentTime = pct * (audioRef.current.duration || 0)
    updatePlayTime(audioRef.current.currentTime)
  }

  return (
    <div className="md:col-span-2 rounded-lg border bg-muted/50 px-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Conversation complete</span>
        <div className="flex flex-wrap items-center gap-2">
          {vcMetricsLoading && (
            <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Spinner className="size-3" /> Analyzing voice…
            </span>
          )}
          {vcMetricsReady && !vcMetricsLoading && (
            <Button variant="outline" size="xs" onClick={onShowVcMetrics} className="border-purple-500/50 text-purple-300 hover:bg-purple-500/10">
              <BarChart3 /> Voice change metrics
            </Button>
          )}
          <Button variant="outline" size="xs" onClick={onDownloadTranscript}>
            <Download /> Transcript
          </Button>
          {originalUserWavUrl && (
            <a href={originalUserWavUrl} download="you-original.wav"
              className="inline-flex items-center gap-1 h-6 rounded-lg border px-2 text-[10px] font-medium hover:bg-muted">
              You (raw)
            </a>
          )}
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
          <Button size="icon" variant="ghost" className="size-7" onClick={togglePlay}>
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
          <div
            className="relative flex-1 h-1.5 rounded-full bg-muted-foreground/20 cursor-pointer"
            onClick={seek}
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
  )
}
