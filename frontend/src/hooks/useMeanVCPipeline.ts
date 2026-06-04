import { useState, useRef, useCallback } from "react";
import { getMeanvcWsUrl, getMeanvcLoadTargetUrl } from "@/lib/config";
import { createWavFile } from "@/lib/audio";

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

    // 5b. Use Recorder with sourceNode to capture from vcDest (MeanVC output only)
    const vcSourceNode = audioCtx.createMediaStreamSource(vcDest.stream);
    const vcRecorder = new Recorder({
      encoderPath: "https://cdn.jsdelivr.net/npm/opus-recorder@latest/dist/encoderWorker.min.js",
      streamPages: true,
      encoderApplication: 2049,
      encoderFrameSize: 40,
      encoderSampleRate: 16000,
      maxFramesPerPage: 1,
      numberOfChannels: 1,
      monitorGain: 0,
      recordingGain: 1,
      sourceNode: vcSourceNode,
    });
    vcRecorderRef.current = vcRecorder;

    vcRecorder.ondataavailable = (arrayBuffer: ArrayBuffer) => {
      onAudioRef.current(arrayBuffer);
    };

    try {
      await vcRecorder.start();
      console.log("[MeanVC] Recorder started on vcDest sourceNode");
    } catch (e: any) {
      console.warn("[MeanVC] Recorder start failed:", e.message);
    }

    // Route MeanVC output → ring buffer → steady ScriptProcessor → vcDest → Recorder
    const ringBuffer: Float32Array[] = [];
    let writeProcessor: ScriptProcessorNode | null = null;
    let procStarted = false;

    function ensureProcessor() {
      if (procStarted || ringBuffer.length < 3) return;
      procStarted = true;
      writeProcessor = audioCtx.createScriptProcessor(2048, 0, 1);
      writeProcessor.connect(vcDest);
      writeProcessor.onaudioprocess = () => {
        if (ringBuffer.length === 0) return;
        // Push data to vcDest even if buffer is too small
        const chunk = ringBuffer.shift()!;
        const buf = audioCtx.createBuffer(1, chunk.length, 16000);
        buf.getChannelData(0).set(chunk);
        const bs = audioCtx.createBufferSource();
        bs.buffer = buf; bs.connect(vcDest); bs.start();
      };
    }

    meanvcWs.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      const float32 = new Float32Array(event.data);
      if (float32.length === 0) return;
      userPcmRef.current.push(new Float32Array(float32));
      ringBuffer.push(new Float32Array(float32));
      ensureProcessor();
    });

// Keep AudioContext alive during streaming
    resumeRef.current = setInterval(() => {
      if (pcmContextRef.current?.state === "suspended") {
        pcmContextRef.current.resume();
      }
    }, 1000);

  }, [state.vcTargetId]);

  const stopVCStream = useCallback(() => {
    if (resumeRef.current) clearInterval(resumeRef.current);
    meanvcWsRef.current?.close();
    meanvcWsRef.current = null;
    (vcRecorderRef.current as any)?.stop?.();
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
    console.log("[MeanVC] User WAV:", total, "samples");
    userPcmRef.current = [];
    return createWavFile(combined, 16000);
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