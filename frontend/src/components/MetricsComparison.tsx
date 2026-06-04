import { useState, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field"
import { compareMetrics } from "@/services/api"
import { GitCompare, AlertCircle, Upload, Volume2 } from "lucide-react"
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

export function MetricsComparison() {
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [targetFile, setTargetFile] = useState<File | null>(null)
  const [comparing, setComparing] = useState(false)
  const [plotUrl, setPlotUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const compare = useCallback(async () => {
    if (!sourceFile || !targetFile) return
    setComparing(true)
    setError(null)
    try {
      setPlotUrl(URL.createObjectURL(await compareMetrics(sourceFile, targetFile)))
    } catch (e: any) {
      setError(e.message || "Comparison failed")
    } finally { setComparing(false) }
  }, [sourceFile, targetFile])

  return (
    <div className="flex flex-col gap-5 rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">Metrics Comparison</h3>
        <p className="text-xs text-muted-foreground">Compare audio quality metrics between two recordings</p>
      </div>

      <FieldGroup>
        <Field>
          <FieldLabel>Original Audio</FieldLabel>
          <UploadZone file={sourceFile} setFile={setSourceFile} />
        </Field>
        <Field>
          <FieldLabel>Converted Audio</FieldLabel>
          <UploadZone file={targetFile} setFile={setTargetFile} />
        </Field>
      </FieldGroup>

      <Button
        onClick={compare}
        disabled={!sourceFile || !targetFile || comparing}
        className="w-full"
      >
        {comparing ? (
          <><Spinner data-icon="inline-start" />Analyzing…</>
        ) : (
          <><GitCompare data-icon="inline-start" />Compare Metrics</>
        )}
      </Button>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {comparing && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {plotUrl && (
        <div className="overflow-hidden rounded-lg border">
          <img src={plotUrl} alt="Metrics chart" className="w-full" />
        </div>
      )}
    </div>
  )
}