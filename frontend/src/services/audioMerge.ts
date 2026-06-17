import { createWavFile } from "@/lib/audio"

export async function mergeAudioTracks(userWav: Blob, pplxWav: Blob): Promise<Blob> {
  const ctx = new AudioContext()
  const [userBuf, ppBuf] = await Promise.all([
    ctx.decodeAudioData(await userWav.arrayBuffer()),
    ctx.decodeAudioData(await pplxWav.arrayBuffer()),
  ])
  const maxLen = Math.max(userBuf.length, ppBuf.length)
  const merged = new Float32Array(maxLen)
  merged.set(userBuf.getChannelData(0), 0)
  for (let i = 0; i < ppBuf.length; i++) {
    merged[i] = Math.max(-1, Math.min(1, merged[i] + ppBuf.getChannelData(0)[i] * 0.8))
  }
  ctx.close()
  return createWavFile(merged, userBuf.sampleRate)
}
