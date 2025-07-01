//worker.js
const originalFetch = fetch.bind(self);

globalThis.fetch = async (input, init) => {
  // normalize to a URL string
  const url = typeof input === "string" ? input : input.url;

  // only intercept real model downloads (.onnx files)
  if (!url.endsWith(".onnx")) {
    // passthrough for everything else (LLM calls, splits, etc)
    return originalFetch(input, init);
  }

  // otherwise do your chunked‐reader wrapper
  const res     = await originalFetch(input, init);
  const total   = Number(res.headers.get("content-length") || 0);
  const reader  = res.body.getReader();
  let   loaded  = 0;

  const progressStream = new ReadableStream({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        self.postMessage({
          type:    "progress",
          loaded,
          total,
          // you can even format MB here
          message: `Downloading model: ${(loaded/1024/1024).toFixed(1)} / ${(total/1024/1024).toFixed(1)} MB`
        });
        controller.enqueue(value);
      }
      controller.close();
    },
  });

  return new Response(progressStream, {
    headers:    res.headers,
    status:     res.status,
    statusText: res.statusText,
  });
};
import {
  // VAD
  AutoModel,

  // LLM
 

  // Speech recognition
  Tensor,
  pipeline,
} from "@huggingface/transformers";

import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import { SCENARIOS } from "./scenarios";
import {
  MAX_BUFFER_DURATION,
  INPUT_SAMPLE_RATE,
  SPEECH_THRESHOLD,
  EXIT_THRESHOLD,
  SPEECH_PAD_SAMPLES,
  MAX_NUM_PREV_BUFFERS,
  MIN_SILENCE_DURATION_SAMPLES,
  MIN_SPEECH_DURATION_SAMPLES,
} from "./constants";
const MODEL_STEPS = [
  { name: "Loading TTS",     fn: () => KokoroTTS.from_pretrained(model_id, { dtype: "fp32", device }) },
  { name: "Loading VAD",     fn: () => AutoModel.from_pretrained("onnx-community/silero-vad", { config: { model_type: "custom" }, dtype: "fp32" }) },
  { name: "Loading ASR",     fn: () => pipeline("automatic-speech-recognition", "onnx-community/whisper-base", { device, dtype: DEVICE_DTYPE_CONFIGS[device] }) },
];

async function loadAllModels() {
  for (let i = 0; i < MODEL_STEPS.length; i++) {
    const { name, fn } = MODEL_STEPS[i];
    self.postMessage({ type: "progress", loaded: i, total: MODEL_STEPS.length, message: name });
    const result = await fn();
    // assign back to your variables
    if (name === "Loading TTS")    voice = result;       // rename as needed
    if (name === "Loading VAD")    silero_vad = result;
    if (name === "Loading ASR")    transcriber = result;
  }
  self.postMessage({ type: "progress", loaded: MODEL_STEPS.length, total: MODEL_STEPS.length, message: "All models loaded" });
  // finally:
  self.postMessage({ type: "status", status: "ready", voices: tts.voices });
}

// instead of doing each await at top, call:
loadAllModels().catch(err => self.postMessage({ type:"error", error: err.message }));
const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";
let voice;
self.postMessage({ type: "info", message: "Starting model downloads…" });
const tts = await KokoroTTS.from_pretrained(model_id, {
  dtype: "fp32",
  device: "webgpu",
});

const device = "webgpu";
self.postMessage({ type: "info", message: `Using device: "${device}"` });
self.postMessage({
  type: "info",
  message: "Loading models...",
  duration: "until_next",
});

// Load models
const silero_vad = await AutoModel.from_pretrained(
  "onnx-community/silero-vad",
  {
    config: { model_type: "custom" },
    dtype: "fp32", // Full-precision
  },
).catch((error) => {
  self.postMessage({ error });
  throw error;
});

const DEVICE_DTYPE_CONFIGS = {
  webgpu: {
    encoder_model: "fp32",
    decoder_model_merged: "fp32",
  },
  wasm: {
    encoder_model: "fp32",
    decoder_model_merged: "q8",
  },
};
const transcriber = await pipeline(
  "automatic-speech-recognition",
  "onnx-community/whisper-base", // or "onnx-community/moonshine-base-ONNX",
  {
    device,
    dtype: DEVICE_DTYPE_CONFIGS[device],
  },
).catch((error) => {
  self.postMessage({ error });
  throw error;
});

await transcriber(new Float32Array(INPUT_SAMPLE_RATE)); // Compile shaders
let currentSystemPrompt = SCENARIOS.interviewer.prompt;
let currentGreet       = SCENARIOS.interviewer.greet;
let LLM_URL   = "https://nodecodestudio.com/videochat/llm.php";   // <- change me
let LLM_MODEL = "llama-3.2-3b-instruct";                                // <- change me
let API_KEY   = "";                                      
async function llmOnce(messages) {
  console.log("🔗 llmOnce() firing with:", messages);
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: LLM_MODEL, stream: false, messages }),
  });
  const json = await res.json();
  const reply = json.choices?.[0]?.message?.content;
  console.log("✅ llmOnce() reply:", reply);
  return reply || "";
}
// Simple SSE / chunked-JSON parser (OpenAI format)
async function* llmStream(messages, abortSignal) {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY && { Authorization: `Bearer ${API_KEY}` }),
    },
    body: JSON.stringify({ model: LLM_MODEL, stream: true, messages }),
    signal: abortSignal,
  });

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();               // keep incomplete

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;

      const delta = JSON.parse(payload)
                       ?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}

const makeSystem = () => ({ role: "system", content: currentSystemPrompt });



let past_key_values_cache;
let stopping_criteria;
self.postMessage({
  type: "status",
  status: "ready",
  message: "Ready!",
  voices: tts.voices,
});

// Global audio buffer to store incoming audio
const BUFFER = new Float32Array(MAX_BUFFER_DURATION * INPUT_SAMPLE_RATE);
let bufferPointer = 0;

// Initial state for VAD
const sr = new Tensor("int64", [INPUT_SAMPLE_RATE], []);
let state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);

// Whether we are in the process of adding audio to the buffer
let isRecording = false;
let isPlaying = false; // new flag

/**
 * Perform Voice Activity Detection (VAD)
 * @param {Float32Array} buffer The new audio buffer
 * @returns {Promise<boolean>} `true` if the buffer is speech, `false` otherwise.
 */
async function vad(buffer) {
  const input = new Tensor("float32", buffer, [1, buffer.length]);

  const { stateN, output } = await silero_vad({ input, sr, state });
  state = stateN; // Update state

  const isSpeech = output.data[0];

  // Use heuristics to determine if the buffer is speech or not
  return (
    // Case 1: We are above the threshold (definitely speech)
    isSpeech > SPEECH_THRESHOLD ||
    // Case 2: We are in the process of recording, and the probability is above the negative (exit) threshold
    (isRecording && isSpeech >= EXIT_THRESHOLD)
  );
}

/**
 * Transcribe the audio buffer
 * @param {Float32Array} buffer The audio buffer
 * @param {Object} data Additional data
 */
const speechToSpeech = async (buffer, data) => {
  console.log("⏳ speechToSpeech()", data);
  isPlaying = true;

  // 1. Transcribe the audio from the user
  const text = await transcriber(buffer).then(({ text }) => text.trim());
  if (["", "[BLANK_AUDIO]"].includes(text)) {
    // If the transcription is empty or a blank audio, we skip the rest of the processing
    return;
  }

  self.postMessage({ type: "transcription", text });
  messages.push({ role: "user", content: text });
  // Set up text-to-speech streaming
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, {
    voice,
  });
  (async () => {
for await (const { text, phonemes, audio } of stream) {
  console.log("🦻 phonemes in worker:", phonemes);
  self.postMessage({
    type:    "output",
    text,
    phonemes,      // make sure this field is here!
    result:  audio
  });
}
  })();

    // 2. Ask the remote LLM and stream tokens into TTS
 const aborter = new AbortController();
  stopping_criteria = { interrupt: () => aborter.abort() }; // keep your interrupt hookup

  const assistantText = await llmOnce(messages);
  splitter.push(assistantText);
  splitter.close();
  messages.push({ role: "assistant", content: assistantText.trim() });
};

// Track the number of samples after the last speech chunk
let postSpeechSamples = 0;
const resetAfterRecording = (offset = 0) => {
  self.postMessage({
    type: "status",
    status: "recording_end",
    message: "Transcribing...",
    duration: "until_next",
  });
  BUFFER.fill(0, offset);
  bufferPointer = offset;
  isRecording = false;
  postSpeechSamples = 0;
};

const dispatchForTranscriptionAndResetAudioBuffer = (overflow) => {
  // Get start and end time of the speech segment, minus the padding
  const now = Date.now();
  const end =
    now - ((postSpeechSamples + SPEECH_PAD_SAMPLES) / INPUT_SAMPLE_RATE) * 1000;
  const start = end - (bufferPointer / INPUT_SAMPLE_RATE) * 1000;
  const duration = end - start;
  const overflowLength = overflow?.length ?? 0;

  // Send the audio buffer to the worker
  const buffer = BUFFER.slice(0, bufferPointer + SPEECH_PAD_SAMPLES);

  const prevLength = prevBuffers.reduce((acc, b) => acc + b.length, 0);
  const paddedBuffer = new Float32Array(prevLength + buffer.length);
  let offset = 0;
  for (const prev of prevBuffers) {
    paddedBuffer.set(prev, offset);
    offset += prev.length;
  }
  paddedBuffer.set(buffer, offset);
  speechToSpeech(paddedBuffer, { start, end, duration });

  // Set overflow (if present) and reset the rest of the audio buffer
  if (overflow) {
    BUFFER.set(overflow, 0);
  }
  resetAfterRecording(overflowLength);
};
let messages = [ makeSystem() ];
let prevBuffers = [];
self.onmessage = async (event) => {
  // 1) pull everything you might need from the frontend
  const { type, buffer, url, key, model, voice: newVoice, scenario, custom } = event.data;

  // 2) endpoint override
  if (type === "set_endpoint") {
    if (typeof url === "string" && url.trim()) {
      LLM_URL = url.trim();
      self.postMessage({
        type: "status",
        status: "endpoint_set",
        message: `Endpoint: ${LLM_URL}`,
      });
    }
    return;
  }

  // 3) api key override
  if (type === "set_api_key") {
    if (typeof key === "string") {
      API_KEY = key.trim();
      self.postMessage({
        type: "status",
        status: "api_key_set",
        message: API_KEY ? "API key set" : "API key cleared",
      });
    }
    return;
  }

  // 4) model override
  if (type === "set_model") {
    if (typeof model === "string" && model.trim()) {
      LLM_MODEL = model.trim();
      self.postMessage({
        type: "status",
        status: "model_set",
        message: `Using LLM model: ${LLM_MODEL}`,
      });
    }
    return;
  }

  // 5) voice override
  if (type === "set_voice") {
    if (typeof newVoice === "string") {
      voice = newVoice;
      self.postMessage({
        type: "status",
        status: "voice_set",
        message: `Voice: ${voice}`,
      });
    }
    return;
  }

  // 6) scenario override
  if (type === "set_scenario" && SCENARIOS[scenario]) {
    const basePrompt = SCENARIOS[scenario].prompt;
    currentSystemPrompt = custom
      ? `${basePrompt}\n${custom}`
      : basePrompt;

    currentGreet = SCENARIOS[scenario].greet;
    messages = [{ role: "system", content: currentSystemPrompt }];

    self.postMessage({
      type:   "status",
      status: "scenario_set",
      message:`Scenario: ${SCENARIOS[scenario].label}`,
    });
    return;
  }

  // 7) refuse audio while TTS is playing
  if (type === "audio" && isPlaying) return;

  // 8) core commands
  switch (type) {
    case "start_call":
      // use the scenario‐specific greeting
      greet(currentGreet);
      return;

    case "end_call":
      messages = [ { role: "system", content: currentSystemPrompt } ];
      past_key_values_cache = null;
      return;

    case "interrupt":
      stopping_criteria?.interrupt?.();
      return;

    case "playback_ended":
      isPlaying = false;
      return;
  }

  // 9) Voice activity detection + transcription logic
  const wasRecording = isRecording;
  const isSpeech = await vad(buffer);

  if (!wasRecording && !isSpeech) {
    if (prevBuffers.length >= MAX_NUM_PREV_BUFFERS) prevBuffers.shift();
    prevBuffers.push(buffer);
    return;
  }

  const remaining = BUFFER.length - bufferPointer;
  if (buffer.length >= remaining) {
    // The buffer is larger than (or equal to) the remaining space in the global buffer,
    // so we perform transcription and copy the overflow to the global buffer
    BUFFER.set(buffer.subarray(0, remaining), bufferPointer);
    bufferPointer += remaining;

    // Dispatch the audio buffer
    const overflow = buffer.subarray(remaining);
    dispatchForTranscriptionAndResetAudioBuffer(overflow);
    return;
  } else {
    // The buffer is smaller than the remaining space in the global buffer,
    // so we copy it to the global buffer
    BUFFER.set(buffer, bufferPointer);
    bufferPointer += buffer.length;
  }

  if (isSpeech) {
    if (!isRecording) {
      // Indicate start of recording
      self.postMessage({
        type: "status",
        status: "recording_start",
        message: "Listening...",
        duration: "until_next",
      });
    }
    // Start or continue recording
    isRecording = true;
    postSpeechSamples = 0; // Reset the post-speech samples
    return;
  }

  postSpeechSamples += buffer.length;

  // At this point we're confident that we were recording (wasRecording === true), but the latest buffer is not speech.
  // So, we check whether we have reached the end of the current audio chunk.
  if (postSpeechSamples < MIN_SILENCE_DURATION_SAMPLES) {
    // There was a short pause, but not long enough to consider the end of a speech chunk
    // (e.g., the speaker took a breath), so we continue recording
    return;
  }

  if (bufferPointer < MIN_SPEECH_DURATION_SAMPLES) {
    // The entire buffer (including the new chunk) is smaller than the minimum
    // duration of a speech chunk, so we can safely discard the buffer.
    resetAfterRecording();
    return;
  }

  dispatchForTranscriptionAndResetAudioBuffer();
};

function greet(text) {
  isPlaying = true;
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice });
  (async () => {
    for await (const { text: chunkText, phonemes, audio } of stream) {
      self.postMessage({
        type:    "output",
        text:    chunkText,
        phonemes,
        result:  audio,
      });
    }
  })();
  splitter.push(text);
  splitter.close();
  messages.push({ role: "assistant", content: text });
}