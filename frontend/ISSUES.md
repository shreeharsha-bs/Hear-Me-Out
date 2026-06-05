# Frontend Issues

## Bugs / Leaks

### 1. `analyzerContext` never closed — `useRecorder.ts:57`
Created on `start()`, not saved to a ref, never closed on `stop()`. Leaks an AudioContext every conversation session.

### 2. Stale `initialSteps` in `startVCStream` — `useMeanVCPipeline.ts:84`
`initialSteps` is captured from the outer function argument at creation time. Changing the steps slider after mount has no effect on an already-created callback. The dep array only includes `state.vcTargetId`.

### 3. Stale `state.recorder` in `stop()` — `useRecorder.ts:101`
`stop()` reads `state.recorder` from the `useCallback` closure. If state updates between renders, this can close the wrong recorder instance.

### 4. VC path starts connection before validating target — `useConversation.ts`
When VC is enabled but no target voice is loaded, `ws.connect()` fires first, then `startVCStream` fails silently with a status message. Should validate `vcTargetId` before calling `ws.connect()`.

---

## Dead Code

### 5. `useSpeechRecognition.ts` — never imported
The entire hook file exists but is not used anywhere in the app.

### 6. `responseChunks` state — `useWebSocket.ts`
`clearResponseChunks()` is called in `startConversation` but `responseChunks` is never read anywhere.

### 7. `getPersonaplexStartTime` and `getConversationDuration` — `useWebSocket.ts`
Both are returned from `useWebSocket` but never called anywhere.

### 8. `amplitude` in `useRecorder` — `useRecorder.ts`
Computed on every animation frame for the entire recording session, but nothing in the UI reads it. No waveform or VU meter is rendered. The `requestAnimationFrame` loop runs unnecessarily.

---

## Technical Debt

### 9. `ScriptProcessorNode` is deprecated
Used in both `useRecorder.ts` (amplitude analysis) and `useMeanVCPipeline.ts` (PCM capture and ring buffer write). Runs on the main thread, causes audio glitches under load. Should be replaced with `AudioWorkletNode`.

### 10. Opus encoder CDN pinned to `@latest`
Both `useRecorder.ts` and `useMeanVCPipeline.ts` load the encoder worker from:
```
https://cdn.jsdelivr.net/npm/opus-recorder@latest/dist/encoderWorker.min.js
```
A breaking release could silently break recording. Should pin to a specific version.

### 11. `voicePrompt` hardcoded in `config.ts`
`const voicePrompt = "NATF2.pt"` is hardcoded and not exposed in the UI or `.env`. Should be at minimum an env variable.

### 12. MeanVC host hardcoded to a KTH IP
`130.237.3.103` is the fallback value in `config.ts`. Should only come from `VITE_MEANVC_HOST` in `.env`, with no hardcoded default.

### 13. No WebSocket reconnection logic
If the PersonaPlex connection drops mid-conversation, the user must manually restart. No exponential backoff or auto-reconnect.

### 14. No loading state after stopping a conversation
After `stopConversation()`, transcription and audio processing happen silently in the background. No spinner or progress indicator is shown to the user.
