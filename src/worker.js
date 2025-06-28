//worker.js
import {
  // VAD
  AutoModel,

  // LLM
 

  // Speech recognition
  Tensor,
  pipeline,
} from "@huggingface/transformers";

import { KokoroTTS, TextSplitterStream } from "kokoro-js";

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

const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";
let voice;
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

let LLM_URL   = "http://localhost:1234/v1/chat/completions";   // <- change me
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

const SYSTEM_MESSAGE = {
  role: "system",
  content:
    "answer in short sentences. you are adam a fun guy. Don't use any special characters such as *",
};


let messages = [SYSTEM_MESSAGE];
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
  messages.push({ role: "user", content: text });

  // Set up text-to-speech streaming
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, {
    voice,
  });
  (async () => {
   for await (const { text, phonemes, audio } of stream) {
  self.postMessage({
    type:    "output",
    text,
    phonemes,        // array of { viseme: "AA", start: 0.12, end: 0.18 }
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

let prevBuffers = [];
self.onmessage = async (event) => {
  const { type, buffer } = event.data;
   // ---- custom setters from the frontend ----
 if (type === "set_endpoint") {
   const { url } = event.data;
   if (typeof url === "string" && url.trim()) {
     LLM_URL = url.trim();
     self.postMessage({ type: "status", status: "endpoint_set", message: `Endpoint: ${LLM_URL}` });
   }
   return;
 }

 if (type === "set_api_key") {
   const { key } = event.data;
   // allow empty to clear
   if (typeof key === "string") {
     API_KEY = key.trim();
     self.postMessage({ type: "status", status: "api_key_set", message: API_KEY ? "API key set" : "API key cleared" });
   }
   return;
 }
 // --------------------------------------------
 if (type === "set_model") {
    // only override if a non-empty string was passed
    if (typeof event.data.model === "string" && event.data.model.trim()) {
      LLM_MODEL = event.data.model;
      self.postMessage({
        type: "status",
        status: "model_set",
        message: `Using LLM model: ${LLM_MODEL}`
      });
    }
    return;
  }
  // refuse new audio while playing back
  if (type === "audio" && isPlaying) return;

  switch (type) {
    case "start_call": {
      const name = tts.voices[voice ?? "af_heart"]?.name ?? "Heart";
      greet(`How can I help you today?`);
      return;
    }
    case "end_call":
      messages = [SYSTEM_MESSAGE];
      past_key_values_cache = null;
    case "interrupt":
     stopping_criteria?.interrupt?.();
      return;
    case "set_voice":
      voice = event.data.voice;
      return;
    case "playback_ended":
      isPlaying = false;
      return;
  }

  const wasRecording = isRecording; // Save current state
  const isSpeech = await vad(buffer);

  if (!wasRecording && !isSpeech) {
    // We are not recording, and the buffer is not speech,
    // so we will probably discard the buffer. So, we insert
    // into a FIFO queue with maximum size of PREV_BUFFER_SIZE
    if (prevBuffers.length >= MAX_NUM_PREV_BUFFERS) {
      // If the queue is full, we discard the oldest buffer
      prevBuffers.shift();
    }
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
    for await (const { text: chunkText, audio } of stream) {
      self.postMessage({ type: "output", text: chunkText, result: audio });
    }
  })();
  splitter.push(text);
  splitter.close();
  messages.push({ role: "assistant", content: text });
}
