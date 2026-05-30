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
  const encoderWorkerRef = useRef<Worker | null>(null);
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
      processor.onaudioprocess = (e) => {
        if (meanvcWs.readyState === WebSocket.OPEN) {
          meanvcWs.send(e.inputBuffer.getChannelData(0).buffer);
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

    // 6. Create encoder Worker and set up encoding pipeline
    const encoderWorker = new Worker(
      "https://cdn.jsdelivr.net/npm/opus-recorder@8.0.5/dist/encoderWorker.min.js",
    );
    encoderWorkerRef.current = encoderWorker;

    let pcmBuffer = new Float32Array(0);
    const FRAME_SIZE = 640;

    meanvcWs.addEventListener("message", async (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      const float32 = new Float32Array(await (event.data as Blob).arrayBuffer());
      if (float32.length === 0) return;

      const merged = new Float32Array(pcmBuffer.length + float32.length);
      merged.set(pcmBuffer, 0);
      merged.set(float32, pcmBuffer.length);
      let offset = 0;
      while (offset + FRAME_SIZE <= merged.length) {
        encoderWorker.postMessage(
          { command: "encode", buffers: [merged.slice(offset, offset + FRAME_SIZE).buffer] },
          [merged.slice(offset, offset + FRAME_SIZE).buffer],
        );
        offset += FRAME_SIZE;
      }
      pcmBuffer = merged.slice(offset);
    });

    encoderWorker.onmessage = (e) => {
      if (e.data && e.data.command === "page" && e.data.page) {
        onAudioRef.current(e.data.page);
      } else if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
        onAudioRef.current(e.data);
      }
    };
    encoderWorker.onerror = () => setState(s => ({ ...s, vcStatus: "Encoder error" }));
    encoderWorker.postMessage({
      command: "init",
      config: {
        encoderApplication: 2049,
        encoderFrameSize: 40,
        encoderSampleRate: 16000,
        maxFramesPerPage: 1,
        numberOfChannels: 1,
        streamPages: true,
      },
    });
  }, [state.vcTargetId]);

  const stopVCStream = useCallback(() => {
    meanvcWsRef.current?.close();
    meanvcWsRef.current = null;
    encoderWorkerRef.current?.terminate();
    encoderWorkerRef.current = null;
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