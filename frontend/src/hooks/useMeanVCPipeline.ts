import { useState, useRef, useCallback } from "react";
import { getMeanvcWsUrl, getMeanvcLoadTargetUrl } from "@/lib/config";

declare var Recorder: any;

export interface MeanVCPipelineState {
  vcEnabled: boolean;
  vcTargetId: string | null;
  vcTargetFile: string | null;
  vcStatus: string;
  vcStreaming: boolean;
}

export function useMeanVCPipeline(
  onPersonaplexAudio: (data: ArrayBuffer) => void,
  initialSteps: number = 8,
) {
  const [state, setState] = useState<MeanVCPipelineState>({
    vcEnabled: false,
    vcTargetId: null,
    vcTargetFile: null,
    vcStatus: "",
    vcStreaming: false,
  });

  const meanvcWsRef = useRef<WebSocket | null>(null);
  const pcmStreamRef = useRef<MediaStream | null>(null);
  const pcmContextRef = useRef<AudioContext | null>(null);
  const vcRecorderRef = useRef<typeof Recorder | null>(null);
  const onAudioRef = useRef(onPersonaplexAudio);
  const userPcmRef = useRef<Float32Array[]>([]);
  const resumeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  onAudioRef.current = onPersonaplexAudio;

  const uploadTarget = useCallback(async (file: File) => {
    setState(s => ({ ...s, vcTargetFile: file.name, vcStatus: "Loading target voice..." }));
    const fd = new FormData();
    fd.append("wav", file);
    try {
      const resp = await fetch(getMeanvcLoadTargetUrl(), { method: "POST", body: fd });
      const data = await resp.json();
      if (data.target_id) {
        setState(s => ({
          ...s,
          vcTargetId: data.target_id,
          vcStatus: `Target ready: ${file.name} (${data.duration_seconds}s)`,
        }));
      } else {
        setState(s => ({ ...s, vcStatus: "Error: " + (data.error || "unknown") }));
      }
    } catch (e: any) {
      setState(s => ({ ...s, vcStatus: "Error: " + (e?.message || e) }));
    }
  }, []);

  const startVCStream = useCallback(async () => {
    if (!state.vcTargetId) {
      setState(s => ({ ...s, vcStatus: "Upload a target voice first" }));
      return;
    }
    setState(s => ({ ...s, vcStatus: "Starting voice conversion pipeline...", vcStreaming: true }));

    // 1. Raw mic
    console.log("[MeanVC] Getting mic...");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    console.log("[MeanVC] Mic obtained, creating AudioContext...");
    pcmStreamRef.current = stream;

    // 2. AudioContext
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    pcmContextRef.current = audioCtx;
    console.log("[MeanVC] AudioContext state:", audioCtx.state);
    await audioCtx.resume();

    // 3. ScriptProcessor for mic PCM
const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(2048, 1, 1);
    const vcDest = audioCtx.createMediaStreamDestination();

    // 4. Connect to MeanVC WS
    const meanvcUrl = getMeanvcWsUrl(state.vcTargetId!, audioCtx.sampleRate, initialSteps);
    console.log("[MeanVC] Connecting to:", meanvcUrl);
    const meanvcWs = new WebSocket(meanvcUrl);
    meanvcWsRef.current = meanvcWs;
    meanvcWs.binaryType = "arraybuffer";

    // 5. Set ALL MeanVC WebSocket handlers BEFORE any async work
    meanvcWs.addEventListener("open", () => {
      console.log("[MeanVC] WebSocket OPEN - starting mic capture");
      setState(s => ({ ...s, vcStatus: "VC pipeline active - connected" }));
      let sentCount = 0;
      processor.onaudioprocess = (e) => {
        if (meanvcWs.readyState === WebSocket.OPEN) {
          meanvcWs.send(e.inputBuffer.getChannelData(0).buffer);
          sentCount++;
          if (sentCount <= 3) console.log("[MeanVC] Sent PCM chunk", sentCount);
        }
      };
      source.connect(processor);
      // Connect to near-silent output (gain 0.001) to keep ScriptProcessor alive
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0.001;
      processor.connect(gainNode);
      gainNode.connect(audioCtx.destination);
    });
    meanvcWs.addEventListener("close", (e: CloseEvent) => {
      console.log("[MeanVC] WebSocket CLOSE:", e.code, e.reason);
      setState(s => ({ ...s, vcStatus: "MeanVC disconnected" }));
    });
    meanvcWs.addEventListener("error", () => {
      console.error("[MeanVC] WebSocket ERROR");
      setState(s => ({ ...s, vcStatus: "MeanVC WebSocket error" }));
});

    // 5b. Use AudioEncoder (WebCodecs) for Opus + Ogg wrapper
    let pageSeq = 0;
    const streamSerial = Math.floor(Math.random() * 0xFFFFFFFF);

    function writeOggPage(data: Uint8Array, granule: number = 0, flags: number = 0): ArrayBuffer {
      const headerSize = 27 + 1;
      const page = new ArrayBuffer(headerSize + data.length);
      const v = new DataView(page);
      const ws = (o: number, s: string) => { for (let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); };
      ws(0, "OggS");
      v.setUint8(4, 0); // version
      v.setUint8(5, flags);
      v.setBigInt64(6, BigInt(granule), true);
      v.setUint32(14, streamSerial, true);
      v.setUint32(18, pageSeq++, true);
      v.setUint32(22, 0, true); // checksum = 0
      v.setUint8(26, 1); // 1 segment
      v.setUint8(27, data.length);
      new Uint8Array(page, headerSize).set(data);
      return page;
    }

    // Send OpusHead identification header
    // OpusHead: "OpusHead" + version(1) + channels(1) + pre-skip(2) + sample_rate(4) + gain(2) + family(1)
    const opusHead = new Uint8Array(19);
    opusHead.set(new TextEncoder().encode("OpusHead"), 0);
    opusHead[8] = 1;   // version
    opusHead[9] = 1;   // channels
    opusHead[10] = 0; opusHead[11] = 0; // pre-skip = 0
    opusHead[12] = 0x80; opusHead[13] = 0x3E; opusHead[14] = 0; opusHead[15] = 0; // 16000 Hz LE
    opusHead[16] = 0; opusHead[17] = 0; // output gain = 0
    opusHead[18] = 0; // channel mapping family = 0
    onAudioRef.current(writeOggPage(opusHead, 0, 2)); // 2=BOS (beginning of stream)

    // Send OpusTags
    const opusTags = new Uint8Array(new TextEncoder().encode("OpusTags"));
    onAudioRef.current(writeOggPage(opusTags, 0, 0));

    let encodeCount = 0;
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        encodeCount++;
        if (encodeCount <= 3) console.log("[MeanVC] Opus frame", encodeCount, "bytes:", buf.byteLength);
        onAudioRef.current(writeOggPage(new Uint8Array(buf)));
      },
      error: (e) => console.error("[MeanVC] Encoder error:", e),
    });
    encoder.configure({ codec: "opus", sampleRate: 16000, numberOfChannels: 1, bitrate: 64000 });
    console.log("[MeanVC] AudioEncoder configured");
    vcRecorderRef.current = encoder as any;

    // Route MeanVC output → encode via AudioEncoder
    let pcmEncodeBuf = new Float32Array(0);
    const ENC_FRAME = 640; // 40ms at 16000Hz

    meanvcWs.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      const float32 = new Float32Array(event.data);
      if (float32.length === 0) return;
      // Save for user WAV
      userPcmRef.current.push(new Float32Array(float32));
      // Route to vcDest for monitoring
      const buf = audioCtx.createBuffer(1, float32.length, 16000);
      buf.getChannelData(0).set(float32);
      const bufSource = audioCtx.createBufferSource();
      bufSource.buffer = buf;
      bufSource.connect(vcDest);
      bufSource.start(audioCtx.currentTime + 0.01);
      // Encode to Opus via AudioEncoder + Ogg wrap → PersonaPlex
      if (encoder.state === "configured") {
        const merged = new Float32Array(pcmEncodeBuf.length + float32.length);
        merged.set(pcmEncodeBuf, 0);
        merged.set(float32, pcmEncodeBuf.length);
        let off = 0;
        while (off + ENC_FRAME <= merged.length) {
          try {
            const frame = new AudioData({
              format: "f32-planar", sampleRate: 16000,
              numberOfFrames: ENC_FRAME, numberOfChannels: 1,
              timestamp: 0, data: merged.slice(off, off + ENC_FRAME),
            });
            encoder.encode(frame);
            frame.close();
          } catch {}
          off += ENC_FRAME;
        }
        pcmEncodeBuf = merged.slice(off);
      }
    });

// Keep AudioContext alive during streaming
    resumeRef.current = setInterval(() => {
      if (pcmContextRef.current?.state === "suspended") {
        pcmContextRef.current.resume();
      }
    }, 1000);

  }, [state.vcTargetId]);

  const stopVCStream = useCallback(() => {
    clearInterval(resumeRef.current);
    meanvcWsRef.current?.close();
    meanvcWsRef.current = null;
    (vcRecorderRef.current as AudioEncoder)?.close();
    vcRecorderRef.current = null;
    pcmStreamRef.current?.getTracks().forEach(t => t.stop());
    pcmStreamRef.current = null;
    pcmContextRef.current?.close();
    pcmContextRef.current = null;
    setState(s => ({ ...s, vcStreaming: false, vcStatus: "" }));
  }, []);

  const getUserAudioWav = useCallback((): Blob | null => {
    const chunks = userPcmRef.current;
    if (chunks.length === 0) return null;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) { combined.set(c, offset); offset += c.length; }
    const int16 = new Int16Array(combined.length);
    for (let i = 0; i < combined.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, combined[i] * 32767));
    }
    const wav = new ArrayBuffer(44 + int16.length * 2);
    const view = new DataView(wav);
    const ws = (off: number, s: string) => { for (let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); };
    ws(0, "RIFF"); view.setUint32(4, 36 + int16.length * 2, true);
    ws(8, "WAVE"); ws(12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ws(36, "data"); view.setUint32(40, int16.length * 2, true);
    new Uint8Array(wav, 44).set(new Uint8Array(int16.buffer));
    console.log("[MeanVC] User WAV:", total, "samples,", wav.byteLength, "bytes");
    userPcmRef.current = [];
    return new Blob([wav], { type: "audio/wav" });
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    setState(s => ({ ...s, vcEnabled: enabled }));
  }, []);

  return {
    ...state,
    setEnabled,
    uploadTarget,
    startVCStream,
    stopVCStream,
    getUserAudioWav,
  };
}