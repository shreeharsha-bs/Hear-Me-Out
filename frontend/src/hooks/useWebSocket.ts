import { useState, useRef, useCallback, useEffect } from "react";
import { getPersonaplexWsURL, getChatProxyWsUrl } from "@/lib/config";
import { createWavFile } from "@/lib/audio";

// When VC is enabled, connect() targets the MeanVC chat-proxy instead of
// PersonaPlex directly. The proxy converts mic audio server-side and forwards
// it to PersonaPlex over localhost.
export interface ProxyDescriptor {
  targetId: string;
  sourceSr: number;
  steps: number;
  voicePrompt?: string;
}

export interface Transcript {
  text: string;
  timestamp: number;
  speaker: "user" | "personaplex";
}

declare global {
  interface Window {
    "ogg-opus-decoder": {
      OggOpusDecoder: new () => OggOpusDecoder;
    };
  }
}

interface OggOpusDecoder {
  readonly ready: Promise<void>;
  decode(packet: Uint8Array): Promise<{
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
  }>;
  free(): void;
}

export function useWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const intentionalClose = useRef(false);
  const decoderRef = useRef<OggOpusDecoder | null>(null);
  const mergedCtxRef = useRef<AudioContext | null>(null);
  const mergedDestRef = useRef<AudioNode | null>(null);
  const mergedEndRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const scheduledEnd = useRef(0);

  const setMergedOutput = useCallback((ctx: AudioContext | null, dest: AudioNode | null) => {
    mergedCtxRef.current = ctx;
    mergedDestRef.current = dest;
    mergedEndRef.current = 0;
  }, []);
  const personaplexOpus = useRef<{ packet: Uint8Array; time: number }[]>([]);
  const vcUserPcm = useRef<Float32Array[]>([]);
  const conversationStart = useRef(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [responseChunks, setResponseChunks] = useState<ArrayBuffer[]>([]);
  const [warmupComplete, setWarmupComplete] = useState(false);
  const [handshakeReceived, setHandshakeReceived] = useState(false);

  useEffect(() => {
    const init = async () => {
      const OggDecoder = window["ogg-opus-decoder"]?.OggOpusDecoder;
      if (OggDecoder) {
        const decoder = new OggDecoder();
        await decoder.ready;
        decoderRef.current = decoder;
        console.log("Opus decoder ready");
      }
      audioCtxRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)({ sampleRate: 48000 });
    };
    init();
    return () => {
      decoderRef.current?.free();
      audioCtxRef.current?.close();
    };
  }, []);

  const playAudio = useCallback((payload: ArrayBuffer) => {
    const decoder = decoderRef.current;
    const ctx = audioCtxRef.current;
    if (!decoder || !ctx) return;

    const raw = new Uint8Array(payload);
    personaplexOpus.current = [...personaplexOpus.current, { packet: raw, time: Date.now() }];

    decoder.decode(raw).then(({ channelData, samplesDecoded }) => {
      if (samplesDecoded === 0) return;

      // Play through speakers
      const buffer = ctx.createBuffer(1, samplesDecoded, ctx.sampleRate);
      buffer.copyToChannel(channelData[0], 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      const start = Math.max(scheduledEnd.current, now);
      src.start(start);
      scheduledEnd.current = start + buffer.duration;

      // Also route to merged capture stream
      const mctx = mergedCtxRef.current;
      const mdest = mergedDestRef.current;
      if (mctx && mdest && mctx.state !== "closed") {
        const mbuf = mctx.createBuffer(1, samplesDecoded, mctx.sampleRate);
        mbuf.copyToChannel(channelData[0], 0);
        const msrc = mctx.createBufferSource();
        msrc.buffer = mbuf;
        msrc.connect(mdest);
        const mnow = mctx.currentTime;
        const mstart = Math.max(mergedEndRef.current, mnow);
        msrc.start(mstart);
        mergedEndRef.current = mstart + mbuf.duration;
      }
    }).catch(() => {});
  }, []);

  const connect = useCallback((textPrompt?: string, proxy?: ProxyDescriptor) => {
    const url = proxy
      ? getChatProxyWsUrl(proxy.targetId, proxy.sourceSr, proxy.steps, textPrompt ?? "", proxy.voicePrompt)
      : getPersonaplexWsURL(textPrompt);
    console.log("Connecting to:", url);
    setError(null);
    personaplexOpus.current = [];
    vcUserPcm.current = [];
    conversationStart.current = Date.now();
    intentionalClose.current = false;

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("WebSocket connected, waiting for handshake...");
      setConnected(true);
    };

    socket.onerror = () => {
      setError("Connection failed. Check if the server is running.");
    };

    socket.onclose = (event) => {
      setConnected(false);
      if (!intentionalClose.current) {
        if (event.code === 1006) {
          setError("Server disconnected unexpectedly. The model may be overloaded.");
        } else if (event.code !== 1000 && event.code !== 1005) {
          setError(`Connection closed (code ${event.code}). ${event.reason || ""}`.trim());
        }
      }
      intentionalClose.current = false;
    };

    socket.onmessage = async (event) => {
      try {
        const arrayBuffer = await (event.data instanceof Blob
          ? event.data.arrayBuffer()
          : event.data);
        const view = new Uint8Array(arrayBuffer);
        const tag = view[0];
        const payload = arrayBuffer.slice(1);

        if (tag === 0) {
          console.log("Handshake received, server ready");
          setWarmupComplete(true);
          setHandshakeReceived(true);
        } else if (tag === 1) {
          playAudio(payload);
        } else if (tag === 2) {
          const decoder = new TextDecoder();
          const text = decoder.decode(payload);
          setPartialTranscript((prev) => {
            const updated = prev + text;
            if (updated.endsWith(".") || updated.endsWith("!") || updated.endsWith("?")) {
              setTranscripts((t) => [...t, { text: updated, timestamp: Date.now(), speaker: "personaplex" }]);
              return "";
            }
            return updated;
          });
        } else if (tag === 3) {
          // Converted user voice from the proxy (raw float32 PCM @16kHz),
          // kept only for the user/merged WAV downloads.
          vcUserPcm.current.push(new Float32Array(payload));
        }
      } catch {
        // Ignore unrecognized messages
      }
    };
  }, [playAudio]);

  const sendAudio = useCallback((data: ArrayBuffer) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      const tagged = new Uint8Array(data.byteLength + 1);
      tagged[0] = 1;
      tagged.set(new Uint8Array(data), 1);
      socketRef.current.send(tagged.buffer);
    }
  }, []);

  // Raw, untagged binary send — used in proxy/VC mode where the chat-proxy
  // expects raw float32 mic PCM.
  const sendRawAudio = useCallback((data: ArrayBuffer) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(data);
    }
  }, []);

  const disconnect = useCallback(() => {
    intentionalClose.current = true;
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
    setWarmupComplete(false);
    setHandshakeReceived(false);
    scheduledEnd.current = 0;
  }, []);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
    setPartialTranscript("");
  }, []);

  const clearResponseChunks = useCallback(() => {
    setResponseChunks([]);
  }, []);

  const getPersonaplexWav = useCallback(async (): Promise<Blob | null> => {
    const packets = personaplexOpus.current;
    console.log("getPersonaplexWav:", packets.length, "packets, decoder:", !!decoderRef.current);
    if (packets.length === 0) return null;
    const decoder = decoderRef.current;
    if (!decoder) return null;

    const allPcm: Float32Array[] = [];
    for (const { packet } of packets) {
      try {
        const { channelData, samplesDecoded } = await decoder.decode(packet);
        if (samplesDecoded > 0) allPcm.push(new Float32Array(channelData[0]));
      } catch {}
    }

    if (allPcm.length === 0) return null;
    const total = allPcm.reduce((s, c) => s + c.length, 0);
    const combined = new Float32Array(total);
    let offset = 0;
    for (const c of allPcm) {
      combined.set(c, offset);
      offset += c.length;
    }
    return createWavFile(combined, 48000);
  }, []);

  // Assemble the converted user voice (0x03 frames) collected in proxy mode.
  const getVcUserWav = useCallback((): Blob | null => {
    const chunks = vcUserPcm.current;
    if (chunks.length === 0) return null;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) { combined.set(c, offset); offset += c.length; }
    console.log("[proxy] VC user WAV:", total, "samples");
    vcUserPcm.current = [];
    return createWavFile(combined, 16000);
  }, []);

  const getPersonaplexStartTime = useCallback((): number => {
    if (personaplexOpus.current.length === 0) return 0;
    return (personaplexOpus.current[0].time - conversationStart.current) / 1000;
  }, []);

  const getConversationDuration = useCallback((): number => {
    const packets = personaplexOpus.current;
    return packets.length * 0.02; // ~20ms per Opus frame
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const addUserTranscript = useCallback((text: string) => {
    if (!text) return;
    setTranscripts((prev) => [...prev, { text, timestamp: Date.now(), speaker: "user" }]);
  }, []);

  return {
    connected,
    error,
    transcripts,
    partialTranscript,
    responseChunks,
    warmupComplete,
    handshakeReceived,
    connect,
    disconnect,
    sendAudio,
    sendRawAudio,
    getVcUserWav,
    clearTranscripts,
    clearResponseChunks,
    clearError,
    addUserTranscript,
    getPersonaplexWav,
    getPersonaplexStartTime,
    getConversationDuration,
    setMergedOutput,
  };
}