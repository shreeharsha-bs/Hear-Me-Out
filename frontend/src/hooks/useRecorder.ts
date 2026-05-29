import { useState, useRef, useCallback } from "react";

declare class Recorder {
  constructor(opts: Record<string, unknown>);
  start(): Promise<void>;
  stop(): void;
  ondataavailable: ((buf: ArrayBuffer) => void) | null;
}

export interface RecorderState {
  recorder: Recorder | null;
  isRecording: boolean;
  amplitude: number;
  recordedChunks: Blob[];
  recordingAvailable: boolean;
}

export function useRecorder(onAudioData: (buf: ArrayBuffer) => void) {
  const [state, setState] = useState<RecorderState>({
    recorder: null,
    isRecording: false,
    amplitude: 0,
    recordedChunks: [],
    recordingAvailable: false,
  });
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const animFrameRef = useRef<number>(0);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingStreamRef.current = stream;

    const recorder = new Recorder({
      encoderPath: "https://cdn.jsdelivr.net/npm/opus-recorder@latest/dist/encoderWorker.min.js",
      streamPages: true,
      encoderApplication: 2049,
      encoderFrameSize: 80,
      encoderSampleRate: 24000,
      maxFramesPerPage: 1,
      numberOfChannels: 1,
    });

    recorder.ondataavailable = async (arrayBuffer: ArrayBuffer) => {
      onAudioData(arrayBuffer);
    };

    await recorder.start();
    setState((s) => ({ ...s, recorder, isRecording: true, recordedChunks: [], recordingAvailable: false }));

    // Amplitude analyzer
    const analyzerContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const analyzer = analyzerContext.createAnalyser();
    analyzer.fftSize = 256;
    const sourceNode = analyzerContext.createMediaStreamSource(stream);
    sourceNode.connect(analyzer);
    const dataArray = new Uint8Array(256);

    const poll = () => {
      analyzer.getByteFrequencyData(dataArray as unknown as Uint8Array<ArrayBuffer>);
      const avg = (dataArray as unknown as number[]).reduce((a, b) => a + b, 0) / dataArray.length;
      setState((s) => ({ ...s, amplitude: avg }));
      animFrameRef.current = requestAnimationFrame(poll);
    };
    poll();

    // WAV media recorder
    const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (ev) => {
      if (ev.data.size > 0) {
        setState((s) => ({ ...s, recordedChunks: [...s.recordedChunks, ev.data] }));
      }
    };
    mr.onstop = () => setState((s) => ({ ...s, recordingAvailable: true }));
    mr.start();
  }, [onAudioData]);

  const stop = useCallback(() => {
    state.recorder?.stop();
    setState((s) => ({ ...s, isRecording: false }));
    mediaRecorderRef.current?.stop();
    recordingStreamRef.current?.getTracks().forEach((t) => t.stop());
    cancelAnimationFrame(animFrameRef.current);
    setState((s) => ({ ...s, amplitude: 0 }));
  }, [state.recorder]);

  return { ...state, start, stop };
}
