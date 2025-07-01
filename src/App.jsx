import { useEffect, useState, useRef } from "react";
import { Mic, PhoneOff, ChevronDown,  Settings  } from "lucide-react";
import { INPUT_SAMPLE_RATE } from "./constants";
import Character from "./Character";
import WORKLET from "./play-worklet.js";
import { SCENARIOS } from "./scenarios";     
export default function App() {
  const [loading, setLoading] = useState({ loaded: 0, total: 1, message: "Initializing…" });

  const [llmModel, setLlmModel] = useState("");  
  const outputAudioContextRef = useRef(null);
  const [scenarioInput, setScenarioInput] = useState("");
  const contactName = "User";
  const isOutgoing = true;              // or false for incoming
  const directionIcon = isOutgoing
    ? <ChevronDown className="w-5 h-5 rotate-90 text-gray-500"/>
    : <ChevronDown className="w-5 h-5 -rotate-90 text-gray-500"/>;
  const [callStartTime, setCallStartTime] = useState(null);
  const [callStarted, setCallStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [llmUrl,    setLlmUrl]    = useState("");
  const [apiKey,    setApiKey]    = useState("");
  const [voice, setVoice] = useState("af_jessica");
  const [scenarioKey, setScenarioKey] = useState("interviewer");
  const [voices, setVoices] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [listeningScale, setListeningScale] = useState(1);
  const [speakingScale, setSpeakingScale] = useState(1);
  const [ripples, setRipples] = useState([]);
  const [visemeTimeline, setVisemeTimeline] = useState([]);
  const [currentViseme,  setCurrentViseme]  = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [elapsedTime, setElapsedTime] = useState("00:00");
  const transcriptRef = useRef(null);
  const worker = useRef(null);
// track loading steps from the worker
 const [loadingProgress, setLoadingProgress] = useState({
   loaded: 0,
   total: 1,
   message: "Initializing…",
 });

  const micStreamRef = useRef(null);
  const node = useRef(null);
  const cumulativeRef         = useRef(0);

useEffect(() => {
  // 1) pull ctx from your ref
  const ctx = outputAudioContextRef.current;

  // 2) bail if nothing to do
  if (!isSpeaking || visemeTimeline.length === 0 || !ctx) return;

  // 3) now you can use ctx safely
  const startTime = ctx.currentTime;
  let rafId;
  const tick = () => {
    const t = ctx.currentTime - startTime;
    const p = visemeTimeline.find(p => t >= p.start && t < p.end);
    setCurrentViseme(p?.viseme ?? null);
    if (t < visemeTimeline[visemeTimeline.length - 1].end) {
      rafId = requestAnimationFrame(tick);
    }
  };
  rafId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(rafId);
}, [isSpeaking, visemeTimeline]);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      // jump to bottom
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript]);
  useEffect(() => {
    worker.current?.postMessage({
      type: "set_voice",
      voice,
    });
  }, [voice]);

  useEffect(() => {
    if (!callStarted) {
      // 1) zero out your cumulative time
      cumulativeRef.current = 0;

      // 2) clear the viseme timeline so you start fresh
      setVisemeTimeline([]);

      // 3) tell the worker the call ended (so it resets too)
      worker.current?.postMessage({ type: "end_call" });
    }
  }, [callStarted]);
  useEffect(() => {
    if (callStarted && callStartTime) {
      const interval = setInterval(() => {
        const diff = Math.floor((Date.now() - callStartTime) / 1000);
        const minutes = String(Math.floor(diff / 60)).padStart(2, "0");
        const seconds = String(diff % 60).padStart(2, "0");
        setElapsedTime(`${minutes}:${seconds}`);
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setElapsedTime("00:00");
    }
  }, [callStarted, callStartTime]);

  useEffect(() => {
    worker.current ??= new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });

    const onMessage = ({ data }) => {
          // 1) handle our new progress events first
        if (data.type === "transcription") {
     setTranscript(t => [
       ...t,
       { role: "user", content: data.text.trim() }
     ]);
     return;
   }
    if (data.type === "progress") {
       setLoadingProgress({
         loaded: data.loaded,
         total: data.total,
         message: data.message,
       });
       return;
     }
      if (data.error) {
        return onError(data.error);
      }

      switch (data.type) {
        case "status":
          if (data.status === "recording_start") {
            setIsListening(true);
            setIsSpeaking(false);
          } else if (data.status === "recording_end") {
            setIsListening(false);
          } else if (data.status === "ready") {
            setVoices(data.voices);
            setReady(true);
             setLoadingProgress(null);
          }
          break;
  case "output":
  node.current?.port.postMessage(data.result.audio);
  setPlaying(true);
  setIsSpeaking(true);

  const phonemeStr = data.phonemes || "";
  const rawTokens  = tokenizeIPA(phonemeStr);
  const ctx        = outputAudioContextRef.current;
  if (!ctx || !rawTokens.length) return;

  // how many seconds this buffer is
const chunkDur = data.result.audio.length / ctx.sampleRate;
const slot     = chunkDur / rawTokens.length;

  // build this chunk’s timeline, offset by cumulativeRef.current
const chunkTimeline = rawTokens.map((tok,i) => ({
  viseme: mapToShape(tok),
  start:  cumulativeRef.current + slot * i,
  end:    cumulativeRef.current + slot * (i + 1),
}));

  // bump your cumulative offset
  cumulativeRef.current += chunkDur;
    const chunk = data.text || "";
  setTranscript(t => {
    const last = t[t.length - 1];
    if (last?.role === "assistant") {
      // 1) Does the existing text end in whitespace or end-of-sentence punctuation?
      const endsWithSpace    = /\s$/.test(last.content);
      // 2) Does the new chunk already start with whitespace?
      const startsWithSpace  = /^\s/.test(chunk);
      // 3) If neither, inject exactly one space
      const separator = endsWithSpace || startsWithSpace ? "" : " ";

      return [
        // everything up to—but not including—the last message
        ...t.slice(0, -1),
        // re-push the merged assistant message
        {
          role: "assistant",
          content: last.content + separator + chunk
        }
      ];
    }
    // First assistant message ever
    return [...t, { role: "assistant", content: chunk }];
  });
  // append & squash
setVisemeTimeline(old =>
  squashTimeline([...old, ...chunkTimeline])

);
  break;
  }
    };
    const onError = (err) => setError(err.message);

    worker.current.addEventListener("message", onMessage);
    worker.current.addEventListener("error", onError);

    return () => {
      worker.current.removeEventListener("message", onMessage);
      worker.current.removeEventListener("error", onError);
    };
  }, []);


  // strip any non-letter/digit, lowercase, fallback to 'rest'
function tokenizeIPA(str = "") {
  // 1) strip stress marks & punctuation
  const clean = String(str)
    .replace(/[ˈˌ.,?]/g, "")
    .toLowerCase();

  // 2) split on whitespace or commas into “chunks”
  const chunks = clean.split(/[,\s]+/).filter(Boolean);

  // 3) break each chunk into real phones
  return chunks.flatMap(splitToPhones);
}
function cleanIPA(tok) {
  return tok
    // collapse length‐mark to a colon or remove if you prefer
    .replace(/ː/g, ":")
    // remove anything that isn’t a letter or colon
    .replace(/[^a-zəʊɪæʌθðŋː:]/gi, "")
    .toLowerCase();
}
function sanitizeViseme(viseme) {
  if (!viseme) return 'rest';
  return (
    viseme
      // remove stress markers & punctuation
      .replace(/[ˈˌ.,?]/g, '')
      // keep only a–z, 0–9, underscore
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase() || 'rest'
  );
}
const IPA_TO_SHAPE = {
  // ── VOWELS & DIPHTHONGS ──
  "aa": "AA",   // ɑː
  "æ":  "AA",
  "a":  "AA",

  "e":  "EH",
  "eh": "EH",
  "eɪ": "EH",
  "ɛ":  "EH",

  // we don’t have a “IH” or “IY” shape, so map i-phones to EH
  "i":  "EH",
  "ɪ":  "EH",
  "i:": "EH",
  "iy": "EH",

  "oʊ": "OO",
  "ow":  "OO",

  "u":  "UU",
  "ʊ":  "UU",
  "u:": "UU",

  // you had UH tokens too; send them to rest
  "ʌ":  "rest",
  "ə":  "rest",
  "uh": "rest",

  // ── CONSONANTS ──
  "p":  "PP",
  "b":  "PP",
  "m":  "PP",   // lips‐together

  "f":  "FF",
  "v":  "FF",

  "θ":  "TH",
  "ð":  "TH",

  "t":  "TD",
  "d":  "TD",

  "s":  "SZ",
  "z":  "SZ",

  "ʃ":  "CH",
  "ʒ":  "CH",
  "tʃ": "CH",
  "dʒ": "CH",

  "k":  "KG",
  "g":  "KG",
  "ŋ":  "KG",

  "l":  "L",
  "ll": "LL",  // if you ever see a double-L token

  "r":  "R",
  "ɹ":  "R",

  // these don’t move the lips in your set
  "h":  "rest",
  "w":  "rest",
  "j":  "rest",
};
const ALL_IPA = Object.keys(IPA_TO_SHAPE)
  .sort((a, b) => b.length - a.length);

function splitToPhones(chunk) {
  const phones = [];
  let i = 0;
  while (i < chunk.length) {
    let matched = false;
    for (const phone of ALL_IPA) {
      if (chunk.slice(i, i + phone.length) === phone) {
        phones.push(phone);
        i += phone.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // skip unknown char
      i++;
    }
  }
  return phones;
}
function squashTimeline(tl) {
  if (!tl.length) return tl;
  return tl.reduce((out, cur) => {
    const prev = out[out.length - 1];
    if (prev && prev.viseme === cur.viseme) {
      // just extend the end
      prev.end = cur.end;
    } else {
      out.push({ ...cur });
    }
    return out;
  }, []);
}
function cleanTok(s) {
  return ("" + s)
    .toLowerCase()
    // collapse common diacritics
    .replace(/[ˈˌ]/g, "")
    // map “j uː” style splits back together
    .replace(/\s+/g, "")
    // keep letters + these IPA symbols
    .replace(/[^a-zːʃθʧɪə]/g, "");
}

function mapToShape(rawTok) {
  const cleaned = cleanIPA(rawTok);
  return IPA_TO_SHAPE[cleaned] || "rest";
}
// strip out diacritics/marks & lowercase
function cleanToken(tok) {
  // guard null and non-string
  const s = tok == null ? "" : String(tok);

  return s
    .replace(/[ˈˌ.,?]/g, "")   // strip stress marks & punctuation
    .replace(/[^A-Za-z]/g, "") // keep only letters
    .toLowerCase();
}



  useEffect(() => {
    if (!callStarted) return;
  const ctx = new AudioContext({ sampleRate: 24000 });
  outputAudioContextRef.current = ctx;
    let worklet;
    let inputAudioContext;
    let source;
    let ignore = false;

    let outputAudioContext;
    const audioStreamPromise = Promise.resolve(micStreamRef.current);

    audioStreamPromise
      .then(async (stream) => {
        if (ignore) return;

        inputAudioContext = new (window.AudioContext ||
          window.webkitAudioContext)({
          sampleRate: INPUT_SAMPLE_RATE,
        });

        const analyser = inputAudioContext.createAnalyser();
        analyser.fftSize = 256;
        source = inputAudioContext.createMediaStreamSource(stream);
        source.connect(analyser);

        const inputDataArray = new Uint8Array(analyser.frequencyBinCount);

        function calculateRMS(array) {
          let sum = 0;
          for (let i = 0; i < array.length; ++i) {
            const normalized = array[i] / 128 - 1;
            sum += normalized * normalized;
          }
          const rms = Math.sqrt(sum / array.length);
          return rms;
        }

        await inputAudioContext.audioWorklet.addModule(
          new URL("./vad-processor.js", import.meta.url),
        );
        worklet = new AudioWorkletNode(inputAudioContext, "vad-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "discrete",
        });

        source.connect(worklet);
        worklet.port.onmessage = (event) => {
          const { buffer } = event.data;
          worker.current?.postMessage({ type: "audio", buffer });
        };

        outputAudioContext = new AudioContext({
          sampleRate: 24000,
        });
        outputAudioContext.resume();

        const blob = new Blob([`(${WORKLET.toString()})()`], {
          type: "application/javascript",
        });
        const url = URL.createObjectURL(blob);
        await outputAudioContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        node.current = new AudioWorkletNode(
          outputAudioContext,
          "buffered-audio-worklet-processor",
        );

 node.current.port.onmessage = (event) => {
  if (event.data.type === "playback_ended") {
    setPlaying(false);
    setIsSpeaking(false);
    // force the mouth back to “rest”
    setCurrentViseme("rest");
    // (optional) clear out any old timeline
    setVisemeTimeline([]);
    // let the worker know too
    cumulativeRef.current = 0;
    worker.current?.postMessage({ type: "playback_ended" });
  }
};

        const outputAnalyser = outputAudioContext.createAnalyser();
        outputAnalyser.fftSize = 256;

        node.current.connect(outputAnalyser);
        outputAnalyser.connect(outputAudioContext.destination);

        const outputDataArray = new Uint8Array(
          outputAnalyser.frequencyBinCount,
        );
 
        function updateVisualizers() {
          analyser.getByteTimeDomainData(inputDataArray);
          const rms = calculateRMS(inputDataArray);
          const targetScale = 1 + Math.min(1.25 * rms, 0.25);
          setListeningScale((prev) => prev + (targetScale - prev) * 0.25);

          outputAnalyser.getByteTimeDomainData(outputDataArray);
          const outputRMS = calculateRMS(outputDataArray);
          const targetOutputScale = 1 + Math.min(1.25 * outputRMS, 0.25);
          setSpeakingScale((prev) => prev + (targetOutputScale - prev) * 0.25);

          requestAnimationFrame(updateVisualizers);
        }
        updateVisualizers();
      })
      .catch((err) => {
        setError(err.message);
        console.error(err);
      });

    return () => {
      ignore = true;
      audioStreamPromise.then((s) => s.getTracks().forEach((t) => t.stop()));
      source?.disconnect();
      worklet?.disconnect();
      inputAudioContext?.close();

      outputAudioContext?.close();
    };
  }, [callStarted]);

  useEffect(() => {
    if (!callStarted) return;
    const interval = setInterval(() => {
      const id = Date.now();
      setRipples((prev) => [...prev, id]);
      setTimeout(() => {
        setRipples((prev) => prev.filter((r) => r !== id));
      }, 1500);
    }, 1000);
    return () => clearInterval(interval);
  }, [callStarted]);

  const handleStartCall = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
          sampleRate: INPUT_SAMPLE_RATE,
        },
      });
      micStreamRef.current = stream;
  worker.current?.postMessage({
    type:     "set_scenario",
    scenario: scenarioKey,
    custom:   scenarioInput.trim(),
  });
      setCallStartTime(Date.now());
      setCallStarted(true);
      worker.current?.postMessage({ type: "start_call" });
    } catch (err) {
      setError(err.message);
      console.error(err);
    }
  };
const bgFile = callStarted
  ? SCENARIOS[scenarioKey].background
  : "camera_off.png";
console.log("🖼️ bgFile:", bgFile, "→ url('/assets/"+bgFile+"')");
if (loadingProgress) {
  const percent = loadingProgress.total
    ? (loadingProgress.loaded / loadingProgress.total) * 100
    : 0;

  return (
    <div className="fixed inset-0 bg-white flex flex-col items-center justify-center z-50 p-4">
      <div className="mb-2 text-lg">{loadingProgress.message}</div>
      <div className="w-64 bg-gray-200 rounded overflow-hidden">
        <div
          className="h-2 bg-green-500"
          style={{ width: `${percent.toFixed(1)}%` }}
        />
      </div>
      <div className="mt-2 text-sm">
        {(loadingProgress.loaded / 1024 / 1024).toFixed(1)} MB /{" "}
        {(loadingProgress.total / 1024 / 1024).toFixed(1)} MB
      </div>
    </div>
  );
}
  return (
    <div className="h-screen flex items-center justify-center bg-gray-50 p-4">
      <div
        className="
          relative 
          bg-white 
          rounded-xl 
          shadow-lg 
          w-full 
          max-w-md 
          flex 
          flex-col
          border-4 border-gray-800
          border-t-teal-400 border-b-teal-400
        "
      >
        {/* ─── HEADER ─── */}
        <div className="flex justify-between items-center px-6 py-4 border-b">
          <div className="flex items-center space-x-2">
             {/* Voice selector */}
          <div className="relative">
            <button
              disabled={!ready}
              className={`
                flex items-center 
                border rounded-lg px-4 py-2 
                ${ready ? 'hover:border-gray-400' : 'bg-gray-100 opacity-50 cursor-not-allowed'}
              `}
            >
                <span className="mr-2">
       {ready
         ? (voices[voice]?.name ?? 'Select voice')
         : 'Loading…'}
     </span>
              <ChevronDown className="w-4 h-4 text-gray-500" />
            </button>
            <select
              value={voice}
              onChange={e => setVoice(e.target.value)}
              disabled={!ready}
              className="absolute inset-0 opacity-0 cursor-pointer"
            >
              {Object.entries(voices).map(([key, v]) => (
                <option key={key} value={key}>
                  {`${v.name} (${v.language} ${v.gender})`}
                </option>
              ))}
            </select>
          </div>
       
          </div>
          <span className="text-lg font-medium">{elapsedTime}</span>
        </div>

  {/* ─── MAIN ─── */}

 <div
   className="flex-1 p-4 min-h-[12rem] bg-cover bg-center relative"
   style={{ backgroundImage: `url('/assets/${bgFile}')` }}
 >
   {callStarted && (
     <div
       className="absolute inset-0 flex items-end justify-center pointer-events-none"
     >
       <Character currentViseme={currentViseme} />
     </div>
   )}
 </div>

        {/* ─── FOOTER ─── */}
        <div className="flex items-center justify-between px-6 py-4 border-t">
          {/* Settings */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-gray-100 rounded-full"
          >
            <Settings className="w-6 h-6 text-gray-600" />
          </button>

        <div className="flex items-center space-x-2">
            {/* Scenario dropdown */}
          <select
   value={scenarioKey}
   onChange={e => setScenarioKey(e.target.value)}
   disabled={callStarted}
   className={`
     border rounded px-2 py-1
     ${callStarted ? 'opacity-50 cursor-not-allowed' : ''}
   `}
 >
              {Object.entries(SCENARIOS).map(([key, s]) => (
                <option key={key} value={key}>{s.label}</option>
              ))}
            </select>
          </div>

          {/* Call button */}
          {callStarted ? (
            <button
              onClick={() => {
                setCallStarted(false);
                setPlaying(false);
                setIsListening(false);
                setIsSpeaking(false);
              }}
              className="p-3 bg-red-100 text-red-700 rounded-full hover:bg-red-200"
            >
              <PhoneOff className="w-6 h-6" />
            </button>
          ) : (
            <button
              onClick={handleStartCall}
              disabled={!ready}
              className={`
                p-3 rounded-full 
                ${ready ? 'bg-green-400 text-white hover:bg-green-500' : 'opacity-50 cursor-not-allowed'}
              `}
            >
              <Mic className="w-6 h-6" />
            </button>
          )}
        </div>
        {/* Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
            <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
              <h2 className="text-lg font-semibold mb-4">LLM Settings</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Model</label>
                  <input
                    type="text"
                    value={llmModel}
                    onChange={e => setLlmModel(e.target.value)}
                    placeholder="e.g. llama-3.2-3b-instruct"
                    className="mt-1 block w-full border rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Endpoint</label>
                  <input
                    type="url"
                    value={llmUrl}
                    onChange={e => setLlmUrl(e.target.value)}
                    placeholder="http://localhost:1234/v1/chat/completions"
                    className="mt-1 block w-full border rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">API Key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="mt-1 block w-full border rounded-md px-3 py-2"
                  />
                </div>
              </div>
              <div className="mt-6 flex justify-end space-x-2">
                <button
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 rounded-md bg-gray-100 hover:bg-gray-200"
                >Cancel</button>
                <button
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700"
                >Save</button>
              </div>
            </div>
          </div>
        )}
        <div className="px-6 py-2 space-y-2">
  <label className="block text-sm font-medium">
    {SCENARIOS[scenarioKey].inputLabel}
  </label>
  <input
    type="text"
    value={scenarioInput}
    onChange={e => setScenarioInput(e.target.value)}
    placeholder={SCENARIOS[scenarioKey].inputPlaceholder}
    className="w-full border rounded px-2 py-1"
  />
</div>
              {/* ─── TRANSCRIPT BOX ─── */}
<div className="px-6 py-4 border-t bg-gray-50">
  <h3 className="font-semibold mb-2">Transcript</h3>
<div
  ref={transcriptRef}
  className="overflow-y-auto max-h-40 p-2 bg-white rounded border"
>
    {transcript.map((m, i) => (
      <div
        key={i}
        className={m.role === "user" ? "text-blue-600" : "text-green-700"}
      >
        <strong>{m.role === "user" ? contactName : "AI"}:</strong>{" "}
        {m.content}
      </div>
    ))}
  </div>
  <button
    onClick={() => {
      const txt = transcript
        .map(
          m =>
            `${m.role === "user" ? contactName : "AI"}: ${m.content}`
        )
        .join("\n");
      const blob = new Blob([txt], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "transcript.txt";
      a.click();
      URL.revokeObjectURL(url);
    }}
    className="mt-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
  >
    Download Transcript
  </button>
  <button
  onClick={() => setTranscript([])}
  className="mt-2 ml-2 px-4 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200"
>
  Reset
</button>
</div>
      </div>

    </div>
  );
}
