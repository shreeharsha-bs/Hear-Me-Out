import { API_BASE } from "@/lib/config"
import { createWavFile } from "@/lib/audio"

export async function transcribeRecording(
  chunks: Blob[]
): Promise<{ text: string; segments: { start: number; end: number; text: string }[] }> {
  const blob = new Blob(chunks, { type: "audio/webm" })
  const arrayBuffer = await blob.arrayBuffer()
  const ctx = new AudioContext()
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
  ctx.close()

  const wavBlob = createWavFile(audioBuffer.getChannelData(0), audioBuffer.sampleRate)
  const formData = new FormData()
  formData.append("audio", wavBlob, "recording.wav")

  const resp = await fetch(`${API_BASE}/api/transcribe`, { method: "POST", body: formData })
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`)
  return resp.json()
}

// Transcribe a WAV blob directly (no webm decode/re-encode round-trip).
// Safer for long clips than transcribeRecording, which rebuilds the audio.
export async function transcribeWavBlob(
  wav: Blob
): Promise<{ text: string; segments: { start: number; end: number; text: string }[] }> {
  const formData = new FormData()
  formData.append("audio", wav, "audio.wav")
  const resp = await fetch(`${API_BASE}/api/transcribe`, { method: "POST", body: formData })
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`)
  return resp.json()
}

export async function convertVoice(sourceFile: File, targetFile: File): Promise<Blob> {
  const fd = new FormData()
  fd.append("source_audio", sourceFile)
  fd.append("target_audio", targetFile)
  const resp = await fetch(`${API_BASE}/api/voice-conversion`, { method: "POST", body: fd })
  if (!resp.ok) throw new Error(await resp.text())
  return resp.blob()
}

export async function compareMetrics(sourceFile: File, targetFile: File): Promise<Blob> {
  const fd = new FormData()
  fd.append("source_audio", sourceFile)
  fd.append("target_audio", targetFile)
  const resp = await fetch(`${API_BASE}/api/metrics-comparison`, { method: "POST", body: fd })
  if (!resp.ok) throw new Error(await resp.text())
  return resp.blob()
}

export interface ResponseMetrics {
  speech_rate: number | null
  sentiment: string | null
  mean_pitch: number | null
  std_pitch: number | null
  transcript?: string | null
  duration?: number | null
}

export interface AestheticMetrics {
  production_quality: number | null
  content_usefulness: number | null
  content_enjoyment: number | null
  production_complexity: number | null
}

export interface MetricsResult {
  response_a: ResponseMetrics
  response_b: ResponseMetrics
  comparison: { semantic_similarity: number | null }
  aesthetics: { response_a: AestheticMetrics; response_b: AestheticMetrics }
}

// JSON variant — returns the raw metrics so the UI renders them as HTML/CSS
// (radar chart + cards) instead of a server-rendered PNG.
export async function compareMetricsData(source: Blob, target: Blob): Promise<MetricsResult> {
  const fd = new FormData()
  // Explicit .wav filenames so the backend's extension check passes for raw Blobs.
  fd.append("source_audio", source, "source.wav")
  fd.append("target_audio", target, "target.wav")
  const resp = await fetch(`${API_BASE}/api/metrics-comparison?output=json`, { method: "POST", body: fd })
  if (!resp.ok) throw new Error(await resp.text())
  return resp.json()
}
