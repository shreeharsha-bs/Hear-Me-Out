import { useState, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field"
import { convertVoice } from "@/services/api"
import { Wand2, Play, AlertCircle, Upload, Volume2 } from "lucide-react"
import { cn } from "@/lib/utils"

function UploadZone({ file, setFile }: { file: File | null; setFile: (f: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-input px-4 py-6 text-sm transition-colors",
          file
            ? "bg-primary/5 border-primary/50 text-primary"
            : "bg-muted/50 text-muted-foreground hover:border-primary/50 hover:bg-muted hover:text-foreground"
        )}
      >
        {file ? (
          <>
            <Volume2 />
            <span className="truncate max-w-[180px]">{file.name}</span>
          </>
        ) : (
          <>
            <Upload />
            Choose file
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
      />
    </>
  )
}

export function VoiceConversion() {
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [targetFile, setTargetFile] = useState<File | null>(null)
  const [converting, setConverting] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const convert = useCallback(async () => {
    if (!sourceFile || !targetFile) return
    setConverting(true)
    setError(null)
    try {
      setResultUrl(URL.createObjectURL(await convertVoice(sourceFile, targetFile)))
    } catch (e: any) {
      setError(e.message || "Conversion failed")
    } finally { setConverting(false) }
  }, [sourceFile, targetFile])

  return (
    <div className="flex flex-col gap-5 rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">Voice Conversion</h3>
        <p className="text-xs text-muted-foreground">Transform audio to match a target speaker&apos;s voice</p>
      </div>

      <FieldGroup>
        <Field>
          <FieldLabel>Source Audio</FieldLabel>
          <UploadZone file={sourceFile} setFile={setSourceFile} />
        </Field>
        <Field>
          <FieldLabel>Target Voice</FieldLabel>
          <UploadZone file={targetFile} setFile={setTargetFile} />
        </Field>
      </FieldGroup>

      <Button
        onClick={convert}
        disabled={!sourceFile || !targetFile || converting}
        className="w-full"
      >
        {converting ? (
          <><Spinner data-icon="inline-start" />Converting…</>
        ) : (
          <><Wand2 data-icon="inline-start" />Convert Voice</>
        )}
      </Button>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {converting && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {resultUrl && (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Play className="text-primary" />
            Result
          </div>
          <audio controls className="w-full" src={resultUrl} />
        </div>
      )}
    </div>
  )
}