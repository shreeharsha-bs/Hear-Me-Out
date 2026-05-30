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
  const vcRecorderRef = useRef<Recorder | null>(null);
  const onAudioRef = useRef(onPersonaplexAudio);
  const userPcmRef = useRef<Float32Array[]>([]);
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
    const meanvcUrl = getMeanvcWsUrl(state.vcTargetId!, audioCtx.sampleRate);
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
    });
    meanvcWs.addEventListener("close", (e: CloseEvent) => {
      console.log("[MeanVC] WebSocket CLOSE:", e.code, e.reason);
      setState(s => ({ ...s, vcStatus: "MeanVC disconnected" }));
    });
    meanvcWs.addEventListener("error", () => {
      console.error("[MeanVC] WebSocket ERROR");
      setState(s => ({ ...s, vcStatus: "MeanVC WebSocket error" }));
    });

    // 5a. Set message handler IMMEDIATELY before any await
    let vcOutputTime = audioCtx.currentTime + 0.5;
    let msgRecd = 0;
    meanvcWs.addEventListener("message", (event: MessageEvent) => {
      msgRecd++;
      if (msgRecd <= 3) console.log("[MeanVC] Rcvd msg", msgRecd, typeof event.data, (event.data as ArrayBuffer)?.byteLength);
      if (typeof event.data === "string") return;
      const float32 = new Float32Array(event.data);
      if (float32.length === 0) { console.log("[MeanVC] Empty PCM"); return; }
      userPcmRef.current.push(new Float32Array(float32));
      const buf = audioCtx.createBuffer(1, float32.length, 16000);
      buf.getChannelData(0).set(float32);
      const bufSource = audioCtx.createBufferSource();
      bufSource.buffer = buf;
      bufSource.connect(vcDest);
      bufSource.start(vcOutputTime);
      vcOutputTime = Math.max(vcOutputTime + buf.duration, audioCtx.currentTime + 0.01);
    });

    // 5b. Create Recorder to encode MeanVC output → Ogg Opus → PersonaPlex
    console.log("[MeanVC] Creating Recorder for Ogg Opus encoding...");
    const vcRecorder = new Recorder({
      encoderPath: "https://cdn.jsdelivr.net/npm/opus-recorder@latest/dist/encoderWorker.min.js",
      streamPages: true,
      encoderApplication: 2049,
      encoderFrameSize: 40,
      encoderSampleRate: 16000,
      maxFramesPerPage: 1,
      numberOfChannels: 1,
      monitorGain: 0,
    });
    vcRecorderRef.current = vcRecorder;

vcRecorder.ondataavailable = (arrayBuffer: ArrayBuffer) => {
      onAudioRef.current(arrayBuffer);
    };

    // 5c. Start the Recorder on the VC output stream
    try {
      await vcRecorder.start(vcDest.stream);
      console.log("[MeanVC] Recorder started on VC stream");
    } catch (e: any) {
      console.warn("[MeanVC] Recorder.start(stream) failed:", e.message, "- trying without stream");
      await vcRecorder.start();
    }

}, [state.vcTargetId]);

  const stopVCStream = useCallback(() => {
    meanvcWsRef.current?.close();
    meanvcWsRef.current = null;
    vcRecorderRef.current?.close?.();
    vcRecorderRef.current = null;
    pcmStreamRef.current?.getTracks().forEach(t => t.stop());
    pcmStreamRef.current = null;
    pcmContextRef.current?.close();
    pcmContextRef.current = null;
    setState(s => ({ ...s, vcStreaming: false, vcStatus: "" }));
  }, []);

  const getUserAudioWav = useCallback((): Blob | null => {
    const chunks = userPcmRef.current;
    console.log("[MeanVC] getUserAudioWav: chunks:", chunks.length, "total samples:", chunks.reduce((s,c)=>s+c.length,0));
    if (chunks.length === 0) return null;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) { combined.set(c, offset); offset += c.length; }
    // Convert Float32 [-1,1] to Int16 for WAV
    const int16 = new Int16Array(combined.length);
    for (let i = 0; i < combined.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, combined[i] * 32767));
    }
    // Write WAV header
    const wav = new ArrayBuffer(44 + int16.length * 2);
    const view = new DataView(wav);
    const writeStr = (off: number, s: string) => { for (let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + int16.length * 2, true);
    writeStr(8, "WAVE"); writeStr(12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, "data"); view.setUint32(40, int16.length * 2, true);
    new Uint8Array(wav, 44).set(new Uint8Array(int16.buffer));
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