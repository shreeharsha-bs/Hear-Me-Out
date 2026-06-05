import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Mic, MicOff, ChevronRight, Wand2, Play, Volume2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { useMeanVCPipeline } from "@/hooks/useMeanVCPipeline"

type VCState = ReturnType<typeof useMeanVCPipeline>

interface Props {
  isConnected: boolean
  isWarming: boolean
  hasError: boolean
  textPrompt: string
  onTextPromptChange: (v: string) => void
  onStart: () => void
  onStop: () => void
  vcPipeline: VCState
  meanvcSteps: number
  onMeanvcStepsChange: (v: number) => void
}

function PipelinePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  )
}

export function ControlPanel({
  isConnected, isWarming, hasError,
  textPrompt, onTextPromptChange,
  onStart, onStop,
  vcPipeline, meanvcSteps, onMeanvcStepsChange,
}: Props) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-4">
      <div className="w-full">
        <textarea
          className="w-full rounded-md border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-none"
          rows={3}
          value={textPrompt}
          onChange={(e) => onTextPromptChange(e.target.value)}
          disabled={isConnected}
          placeholder="Persona prompt..."
        />
      </div>

      <div className="relative">
        {isConnected && (
          <div className="animate-pulse absolute inset-0 -m-1.5 rounded-full pointer-events-none shadow-[0_0_0_6px_rgba(239,68,68,0.35)]" />
        )}
        {hasError && !isConnected && (
          <div className="animate-pulse absolute inset-0 -m-1.5 rounded-full pointer-events-none shadow-[0_0_0_6px_rgba(239,68,68,0.12)]" />
        )}
        <Button
          variant={isConnected || hasError ? "destructive" : "default"}
          onClick={isConnected ? onStop : onStart}
          disabled={isWarming || (vcPipeline.vcEnabled && !vcPipeline.vcTargetId)}
          className={cn(
            "size-12 rounded-full",
            isConnected && "bg-red-500 hover:bg-red-600 text-white border-0 ring-4 ring-red-500/30",
            !isConnected && !hasError && !isWarming && "shadow-md shadow-primary/20"
          )}
          aria-label={isConnected ? "Stop recording" : "Start recording"}
        >
          {isWarming ? <Spinner className="text-primary-foreground" /> : isConnected ? <MicOff /> : <Mic />}
        </Button>
      </div>

      {isConnected && !isWarming && (
        <div className="flex flex-col items-center gap-0.5 text-center">
          <p className="text-xs font-medium text-red-400">Recording…</p>
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

      <div className="w-full rounded-lg border border-purple-500/50 bg-purple-500/10 p-2.5 space-y-2">
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
              onChange={(e) => { const f = e.target.files?.[0]; if (f) vcPipeline.uploadTarget(f) }}
              className="w-full text-[10px] text-muted-foreground file:mr-2 file:py-0.5 file:px-2 file:rounded file:bg-purple-600 file:text-white file:border-0 hover:file:bg-purple-500"
            />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">Steps: {meanvcSteps}</span>
              <input
                type="range"
                min="1"
                max="10"
                value={meanvcSteps}
                onChange={(e) => onMeanvcStepsChange(Number(e.target.value))}
                disabled={vcPipeline.vcStreaming}
                className="w-full h-1 accent-purple-500"
              />
            </div>
            {vcPipeline.vcStatus && (
              <div className="flex items-center gap-1.5">
                <p className={`text-[10px] flex-1 ${vcPipeline.vcStatus.includes("Error") ? "text-red-400" : "text-green-400"}`}>
                  {vcPipeline.vcStatus}
                </p>
                {vcPipeline.vcTargetUrl && (
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      const a = new Audio(vcPipeline.vcTargetUrl!);
                      a.play();
                    }}
                    className="inline-flex items-center justify-center size-5 rounded-full bg-purple-600/20 hover:bg-purple-600/40 transition-colors flex-shrink-0"
                    title="Preview target voice"
                  >
                    <Volume2 className="size-3 text-purple-400" />
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <Badge
        variant={hasError ? "destructive" : isConnected ? "default" : "secondary"}
        className="text-[10px]"
      >
        {hasError ? "Error" : isConnected ? "Connected" : "Ready"}
      </Badge>
    </div>
  )
}
