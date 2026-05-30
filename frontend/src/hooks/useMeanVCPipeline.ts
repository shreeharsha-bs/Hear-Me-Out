import { useState, useRef, useCallback } from "react";
import { MEANVC_HOST } from "@/lib/config";

declare class Recorder {
  constructor(opts: Record<string, unknown>);
  start(stream?: MediaStream): Promise<void>;
  stop(): void;
  setRecordingGain(gain: number): void;
  ondataavailable: ((buf: ArrayBuffer) => void) | null;
}

export interface MeanVCPipelineState {
  vcEnabled: boolean;
  vcTargetId: string | null;
  vcTargetFile: string | null;
  vcStatus: string;
  vcStreaming: boolean;
}

export function useMeanVCPipeline(
  onPersonaplexAudio: (data: ArrayBuffer) => void,
  onUserTranscript: (text: string) => void,
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
  const speechWsRef = useRef<WebSocket | null>(null);

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

    // 2. AudioContext for MeanVC output
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    pcmContextRef.current = audioCtx;

    // 3. ScriptProcessor for mic PCM capture
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(2048, 1, 1);

    // 4. MediaStreamDestination for VC output → OpusRecorder
    const vcDest = audioCtx.createMediaStreamDestination();

    // 5. Connect to MeanVC WS
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const meanvcUrl = `${wsProtocol}//${MEANVC_HOST}:5002/api/meanvc/stream?target_id=${state.vcTargetId}&steps=8&source_sr=${audioCtx.sampleRate}`;
    const meanvcWs = new WebSocket(meanvcUrl);
    meanvcWsRef.current = meanvcWs;

    let vcOutputTime = audioCtx.currentTime + 0.5;

    meanvcWs.onmessage = async (event) => {
      if (typeof event.data === "string") return;
      const float32 = new Float32Array(await (event.data as Blob).arrayBuffer());
      if (float32.length === 0) return;
      const buf = audioCtx.createBuffer(1, float32.length, 16000);
      buf.getChannelData(0).set(float32);
      const bufSource = audioCtx.createBufferSource();
      bufSource.buffer = buf;
      bufSource.connect(vcDest);
      bufSource.start(vcOutputTime);
      vcOutputTime = Math.max(vcOutputTime + buf.duration, audioCtx.currentTime + 0.01);
    };

    // 6. OpusRecorder captures from VC output → PersonaPlex
    const vcRecorder = new Recorder({
      encoderPath: "https://cdn.jsdelivr.net/npm/opus-recorder@latest/dist/encoderWorker.min.js",
      streamPages: true,
      encoderApplication: 2049,
      encoderFrameSize: 40,
      encoderSampleRate: 16000,
      maxFramesPerPage: 1,
      numberOfChannels: 1,
    });
    vcRecorderRef.current = vcRecorder;

    vcRecorder.ondataavailable = async (arrayBuffer: ArrayBuffer) => {
      onPersonaplexAudio(arrayBuffer);
    };

    meanvcWs.onopen = () => {
      setState(s => ({ ...s, vcStatus: "VC pipeline active - connected" }));
      vcRecorder.start(vcDest.stream).then(() => {
        processor.onaudioprocess = (e) => {
          if (meanvcWs.readyState === WebSocket.OPEN) {
            meanvcWs.send(e.inputBuffer.getChannelData(0).buffer);
          }
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
      });
    };

    meanvcWs.onclose = () => setState(s => ({ ...s, vcStatus: "MeanVC disconnected" }));
    meanvcWs.onerror = () => setState(s => ({ ...s, vcStatus: "MeanVC WebSocket error" }));
  }, [state.vcTargetId, onPersonaplexAudio]);

  const stopVCStream = useCallback(() => {
    meanvcWsRef.current?.close();
    meanvcWsRef.current = null;
    vcRecorderRef.current?.stop();
    vcRecorderRef.current = null;
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
    vcRecorderRef,
  };
}