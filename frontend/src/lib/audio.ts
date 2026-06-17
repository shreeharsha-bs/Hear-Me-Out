export function getTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-");
}

export function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function createWavFile(audioData: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = audioData.length * bytesPerSample;
  const bufferSize = 44 + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < audioData.length; i++) {
    const sample = Math.max(-1, Math.min(1, audioData[i]));
    const value = sample < 0 ? sample * 32768 : sample * 32767;
    view.setInt16(offset, value, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export async function webmToWavBlob(chunks: Blob[]): Promise<Blob> {
  const blob = new Blob(chunks, { type: "audio/webm" });
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  return createWavFile(audioBuffer.getChannelData(0), audioBuffer.sampleRate);
}

export function mergeAudioBlobs(blobs: Blob[]): Blob {
  return new Blob(blobs, { type: "audio/wav" });
}

export async function wavBlobToPcm(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  const pcm = new Float32Array(audioBuffer.getChannelData(0));
  ctx.close();
  return pcm;
}

export function mergeFloat32s(arrays: Float32Array[]): Float32Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const a of arrays) {
    merged.set(a, offset);
    offset += a.length;
  }
  return merged;
}
