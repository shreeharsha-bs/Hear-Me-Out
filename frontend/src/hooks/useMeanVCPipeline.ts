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

    let vcOutputTime = audioCtx.currentTime + 0.5;

    meanvcWs.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      const float32 = new Float32Array(event.data);
      if (float32.length === 0) return;
      const buf = audioCtx.createBuffer(1, float32.length, 16000);
      buf.getChannelData(0).set(float32);
      const bufSource = audioCtx.createBufferSource();
      bufSource.buffer = buf;
      bufSource.connect(vcDest);
      bufSource.start(vcOutputTime);
      vcOutputTime = Math.max(vcOutputTime + buf.duration, audioCtx.currentTime + 0.01);
    });

    let pcmBuffer = new Float32Array(0);
    let msgCount = 0;

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