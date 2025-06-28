# React Speech Avatar

A React application that transforms live microphone input into a conversational experience with:

- **Voice Activity Detection** (VAD) via Silero.  
- **Automatic Speech Recognition** (Whisper) to transcribe user speech.  
- **LLM integration** for dynamic responses (configurable endpoint & model).  
- **Streaming Text-to-Speech** (KokoroTTS) with real-time audio output.  
- **2D avatar lip-sync** driven by viseme sprites for natural mouth movements.  
- **Interactive UI**: select voice, settings modal, start/end call button, and ripple visualizer.

---

## Table of Contents

- [Demo](#demo)  
- [Features](#features)  
- [Prerequisites](#prerequisites)  
- [Installation](#installation)  
- [Configuration](#configuration)  
- [Usage](#usage)  
- [Project Structure](#project-structure)  
- [Assets](#assets)  
- [Contributing](#contributing)  
- [License](#license)  

---

## Demo

![App Mockup](./chatwindow.png)

---

## Features

1. **Real-time VAD & ASR** — automatically detect speech and transcribe.  
2. **LLM chat** — send transcribed text to your LLM endpoint (e.g., `llama-3.2-3b-instruct`).  
3. **Streaming TTS** — play back responses as audio chunks on the fly.  
4. **Viseme lip-sync** — animate a 2D character (`face.png` + sprite-based mouth shapes).  
5. **Responsive UI** — header with contact name & call timer, central avatar, footer controls.  
6. **Voice selector** — swap between available TTS voices.  
7. **Settings modal** — configure endpoint, API key, and model.  
8. **Ripple visualizer** — subtle pulsing effect during call.

---

## Prerequisites

- **Node.js** v16+ (or newer)  
- **Yarn** (preferred) or npm  
- **Modern browser** with Web Audio API & Web Workers support (Chrome, Firefox)  

---

## Installation

```bash
# Clone the repo
git clone https://github.com/your-username/react-speech-avatar.git
cd react-speech-avatar

# Install dependencies
yarn install      # or npm install

## Assets
Filename
Description
face.png
Base head image, transparent BG
mouth_rest.png
Neutral mouth shape
mouth_PP.png
Viseme for P, B, M
mouth_FF.png
Viseme for F, V
mouth_TH.png
Viseme for TH (θ, ð)
mouth_TD.png
Viseme for T, D, N
mouth_CH.png
Viseme for CH, SH, JH
mouth_SZ.png
Viseme for S, Z
mouth_KG.png
Viseme for K, G, NG
mouth_R.png
Viseme for R
mouth_L.png
Viseme for L
mouth_AA.png
Viseme for AA (ɑː, æ, ʌ)
mouth_EH.png
Viseme for EH (ɛ, e)
mouth_II.png
Viseme for II (ɪ, i)
mouth_OO.png
Viseme for OO (oʊ, ɔ)
mouth_UU.png
Viseme for UU (ʊ, u)
