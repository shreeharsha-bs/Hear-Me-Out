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
  const onAudioRef = useRef(onPersonaplexAudio);
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
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
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
      processor.connect(audioCtx.destination);
    });
    meanvcWs.addEventListener("close", (e: CloseEvent) => {
      console.log("[MeanVC] WebSocket CLOSE:", e.code, e.reason);
      setState(s => ({ ...s, vcStatus: "MeanVC disconnected" }));
    });
    meanvcWs.addEventListener("error", () => {
      console.error("[MeanVC] WebSocket ERROR");
      setState(s => ({ ...s, vcStatus: "MeanVC WebSocket error" }));
    });

    // 5b. Set up native AudioEncoder (WebCodecs) for Opus encoding
    let pcmBuffer = new Float32Array(0);
    const FRAME_SIZE = 960; // 40ms at 24000Hz
    let msgCount = 0;
    let encoder: AudioEncoder | null = null;
    let encodeCount = 0;

    try {
      encoder = new AudioEncoder({
        output: (chunk) => {
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buf);
          encodeCount++;
          if (encodeCount <= 3) console.log("[MeanVC] Opus frame sent, bytes:", buf.byteLength);
          onAudioRef.current(buf);
        },
        error: (e) => console.error("[MeanVC] Encoder error:", e),
      });
      encoder.configure({
        codec: "opus",
        sampleRate: 24000,
        numberOfChannels: 1,
        bitrate: 64000,
      });
      console.log("[MeanVC] AudioEncoder configured, state:", encoder.state);
    } catch (e: any) {
      console.error("[MeanVC] AudioEncoder init failed:", e.message);
    }

    meanvcWs.addEventListener("message", (event: MessageEvent) => {
      msgCount++;
      if (msgCount <= 3) console.log("[MeanVC] Received message", msgCount, "bytes:", (event.data as ArrayBuffer)?.byteLength);
      if (typeof event.data === "string") return;
      const float32 = new Float32Array(event.data);
      if (float32.length === 0) return;

      const merged = new Float32Array(pcmBuffer.length + float32.length);
      merged.set(pcmBuffer, 0);
      merged.set(float32, pcmBuffer.length);
      let offset = 0;
      while (offset + FRAME_SIZE <= merged.length) {
        if (!encoder || encoder.state !== "configured") break;
        try {
          const frame = new AudioData({
            format: "f32-planar",
            sampleRate: 24000,
            numberOfFrames: FRAME_SIZE,
            numberOfChannels: 1,
            timestamp: 0,
            data: merged.slice(offset, offset + FRAME_SIZE),
          });
          encoder.encode(frame);
          frame.close();
        } catch (e: any) {
          if (msgCount <= 3) console.error("[MeanVC] AudioData encode error:", e.message);
        }
        offset += FRAME_SIZE;
      }
      pcmBuffer = merged.slice(offset);
    });

    }, [state.vcTargetId]);

  const stopVCStream = useCallback(() => {
    meanvcWsRef.current?.close();
    meanvcWsRef.current = null;
    pcmStreamRef.current?.getTracks().forEach(t => t.stop());
    pcmStreamRef.current = null;
    pcmContextRef.current?.close();
    pcmContextRef.current = null;
    setState(s => ({ ...s, vcStreaming: false, vcStatus: "" }));
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
  };
}