import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Legend, Tooltip,
} from "recharts"
import { Badge } from "@/components/ui/badge"
import type { MetricsResult, ResponseMetrics } from "@/services/api"
import { Gauge, Smile, Activity, Waves } from "lucide-react"

const COLOR_A = "#22C55E" // Original speaker
const COLOR_B = "#EF4444" // Voice-converted speaker

const num = (v: number | null | undefined, digits = 0, suffix = "") =>
  v === null || v === undefined || Number.isNaN(v) ? "N/A" : `${v.toFixed(digits)}${suffix}`

function MetricRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="opacity-70">{icon}</span>
        <span className="text-xs">{label}</span>
      </div>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  )
}

function ResponseCard({ title, color, m }: { title: string; color: string; m: ResponseMetrics }) {
  return (
    <div
      className="flex flex-col rounded-lg border-2 p-4"
      style={{ borderColor: `${color}55`, backgroundColor: `${color}0d` }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <div className="divide-y divide-border/60">
        <MetricRow icon={<Gauge className="size-3.5" />} label="Speech Rate" value={num(m.speech_rate, 1, " syl/s")} />
        <MetricRow icon={<Smile className="size-3.5" />} label="Sentiment" value={m.sentiment ?? "N/A"} />
        <MetricRow icon={<Activity className="size-3.5" />} label="Mean Pitch" value={num(m.mean_pitch, 0, " Hz")} />
        <MetricRow icon={<Waves className="size-3.5" />} label="Pitch Std Dev" value={num(m.std_pitch, 0, " Hz")} />
      </div>
    </div>
  )
}

const AXES: { key: keyof MetricsResult["aesthetics"]["response_a"]; label: string }[] = [
  { key: "production_quality", label: "Production Quality" },
  { key: "content_enjoyment", label: "Content Enjoyment" },
  { key: "production_complexity", label: "Production Complexity" },
  { key: "content_usefulness", label: "Content Usefulness" },
]

export function MetricsResultView({ data }: { data: MetricsResult }) {
  const radarData = AXES.map(({ key, label }) => ({
    axis: label,
    a: data.aesthetics.response_a[key] ?? 0,
    b: data.aesthetics.response_b[key] ?? 0,
  }))
  const sim = data.comparison.semantic_similarity

  return (
    <div className="flex flex-col gap-5">
      {/* Aesthetic radar (Audiobox PQ/CE/PC/CU) */}
      <div className="rounded-lg border bg-card p-4">
        <h4 className="mb-2 text-sm font-semibold">Audio Aesthetics</h4>
        <ResponsiveContainer width="100%" height={320}>
          <RadarChart data={radarData} outerRadius="68%">
            <PolarGrid />
            <PolarAngleAxis dataKey="axis" tick={{ fontSize: 11 }} />
            <PolarRadiusAxis angle={90} domain={[0, 10]} tick={{ fontSize: 9 }} />
            <Radar name="Original" dataKey="a" stroke={COLOR_A} fill={COLOR_A} fillOpacity={0.22} />
            <Radar name="Converted" dataKey="b" stroke={COLOR_B} fill={COLOR_B} fillOpacity={0.22} />
            <Legend />
            <Tooltip formatter={(v) => Number(v).toFixed(2)} />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Per-response text/pitch metrics */}
      <div className="grid gap-4 sm:grid-cols-2">
        <ResponseCard title="Original Speaker" color={COLOR_A} m={data.response_a} />
        <ResponseCard title="Voice Converted Speaker" color={COLOR_B} m={data.response_b} />
      </div>

      {/* Semantic similarity */}
      <div className="flex items-center justify-center gap-2 rounded-lg border bg-muted/40 py-3">
        <span className="text-xs text-muted-foreground">Semantic Similarity</span>
        <Badge variant="secondary" className="text-sm tabular-nums">
          {sim === null || sim === undefined ? "N/A" : sim.toFixed(2)}
        </Badge>
      </div>
    </div>
  )
}
