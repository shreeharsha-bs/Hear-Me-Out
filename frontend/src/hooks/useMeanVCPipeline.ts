import { useState, useRef, useCallback } from "react";
import { MEANVC_HOST } from "@/lib/config";

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

  const uploadTarget = useCallback(async (file: File) => {
    setState(s => ({ ...s, vcTargetFile: file.name, vcStatus: "Loading target voice..." }));
    const fd = new FormData();
    fd.append("wav", file);
    try {
      const resp = await fetch(
        `https://${MEANVC_HOST}:5002/api/meanvc/load-target`,
        { method: "POST", body: fd },
      );
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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    pcmStreamRef.current = stream;

    // 2. AudioContext
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    pcmContextRef.current = audioCtx;

    // 3. ScriptProcessor for mic PCM
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(2048, 1, 1);

    // 4. Connect to MeanVC WS
    const meanvcUrl = `wss://${MEANVC_HOST}:5002/api/meanvc/stream?target_id=${state.vcTargetId}&steps=8&source_sr=${audioCtx.sampleRate}`;
    const meanvcWs = new WebSocket(meanvcUrl);
    meanvcWsRef.current = meanvcWs;

    // 5. Create encoder Worker for Opus encoding of MeanVC output
    const encoderWorker = new Worker(
      "https://cdn.jsdelivr.net/npm/opus-recorder@8.0.5/dist/encoderWorker.min.js",
    );
    encoderWorkerRef.current = encoderWorker;

    // Buffer to accumulate PCM samples for Opus frame (40ms at 16000Hz = 640 samples)
    let pcmBuffer = new Float32Array(0);
    const FRAME_SIZE = 640;

    encoderWorker.onmessage = (e) => {
      // Opus-encoded data from the worker
      if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
        onPersonaplexAudio(e.data);
      }
    };

    // Initialize encoder
    encoderWorker.postMessage({
      command: "init",
      config: {
        encoderApplication: 2049,
        encoderFrameSize: 40,     // ms
        encoderSampleRate: 16000,
        maxFramesPerPage: 1,
        numberOfChannels: 1,
        streamPages: true,
      },
    });

    encoderWorker.onerror = () => {
      setState(s => ({ ...s, vcStatus: "Encoder error" }));
    };

    meanvcWs.onmessage = async (event) => {
      if (typeof event.data === "string") return;
      const float32 = new Float32Array(await (event.data as Blob).arrayBuffer());
      if (float32.length === 0) return;

      // Accumulate samples, send full Opus frames
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
    };

    meanvcWs.onopen = () => {
      setState(s => ({ ...s, vcStatus: "VC pipeline active - connected" }));
      processor.onaudioprocess = (e) => {
        if (meanvcWs.readyState === WebSocket.OPEN) {
          meanvcWs.send(e.inputBuffer.getChannelData(0).buffer);
        }
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
    };

    meanvcWs.onclose = () => setState(s => ({ ...s, vcStatus: "MeanVC disconnected" }));
    meanvcWs.onerror = () => setState(s => ({ ...s, vcStatus: "MeanVC WebSocket error" }));
  }, [state.vcTargetId, onPersonaplexAudio]);

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