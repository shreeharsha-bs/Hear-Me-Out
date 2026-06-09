import { useState, useRef, useCallback } from "react";
import { getMeanvcLoadTargetUrl } from "@/lib/config";
import type { ProxyDescriptor } from "@/hooks/useWebSocket";

export interface MeanVCPipelineState {
  vcEnabled: boolean;
  vcTargetId: string | null;
  vcTargetFile: string | null;
  vcTargetUrl: string | null;
  vcStatus: string;
  vcStreaming: boolean;
}

// VC mic capture. Conversion now happens server-side in the MeanVC chat-proxy,
// so this hook only: (1) uploads the target voice, and (2) captures raw mic PCM
// and forwards it untagged to the proxy socket via `sendRawAudio`. The proxy
// converts each chunk and relays it to PersonaPlex over localhost.
export function useMeanVCPipeline(
  sendRawAudio: (data: ArrayBuffer) => void,
  initialSteps: number = 8,
) {
  const [state, setState] = useState<MeanVCPipelineState>({
    vcEnabled: false,
    vcTargetId: null,
    vcTargetFile: null,
    vcTargetUrl: null,
    vcStatus: "",
    vcStreaming: false,
  });

  const pcmStreamRef = useRef<MediaStream | null>(null);
  const pcmContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sendingRef = useRef(false);
  const resumeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendRawRef = useRef(sendRawAudio);
  sendRawRef.current = sendRawAudio;

  const uploadTarget = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    // Revoke previous URL
    if (state.vcTargetUrl) URL.revokeObjectURL(state.vcTargetUrl);
    setState(s => ({ ...s, vcTargetFile: file.name, vcTargetUrl: url, vcStatus: "Loading target voice..." }));
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

  // Phase 1: acquire mic + audio graph. Returns the proxy descriptor (including
  // the actual mic sample rate) so the caller can open the proxy socket with the
  // right source_sr. Mic frames are NOT sent until beginSending() flips the gate
  // (called once the PersonaPlex handshake arrives via the proxy).
  const startMic = useCallback(async (): Promise<ProxyDescriptor> => {
    if (!state.vcTargetId) {
      setState(s => ({ ...s, vcStatus: "Upload a target voice first" }));
      throw new Error("No target voice loaded");
    }
    setState(s => ({ ...s, vcStatus: "Starting microphone...", vcStreaming: true }));

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    pcmStreamRef.current = stream;

    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    pcmContextRef.current = audioCtx;
    await audioCtx.resume();

    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(2048, 1, 1);
    processorRef.current = processor;
    sendingRef.current = false;

    processor.onaudioprocess = (e) => {
      if (!sendingRef.current) return;
      sendRawRef.current(e.inputBuffer.getChannelData(0).buffer);
    };
    source.connect(processor);
    // Near-silent sink keeps the ScriptProcessor firing.
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0.001;
    processor.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    // Keep AudioContext alive during streaming
    resumeRef.current = setInterval(() => {
      if (pcmContextRef.current?.state === "suspended") {
        pcmContextRef.current.resume();
      }
    }, 1000);

    return {
      targetId: state.vcTargetId,
      sourceSr: audioCtx.sampleRate,
      steps: initialSteps,
      voicePrompt: "NATF2.pt",
    };
  }, [state.vcTargetId, initialSteps]);

  // Phase 2: open the gate so mic PCM starts flowing to the proxy.
  const beginSending = useCallback(() => {
    sendingRef.current = true;
    setState(s => ({ ...s, vcStatus: "VC pipeline active - connected" }));
  }, []);

  const stopVCStream = useCallback(() => {
    sendingRef.current = false;
    if (resumeRef.current) clearInterval(resumeRef.current);
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
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
    startMic,
    beginSending,
    stopVCStream,
  };
}
