/* ============================================================
   PiTalk Global — front-end shell
   NOTE FOR GOODHOPE:
   - Minimal working MVP: real speech recognition, real machine
     translation, real spoken output — for English <-> French
     (and Chinese, best-effort) using free browser + public APIs.
   - Speech recognition & speech synthesis use the browser's
     built-in Web Speech API (Chrome only, reliable).
   - Translation uses the free MyMemory API (no key, CORS-enabled,
     ~5,000 chars/day per visitor). Fine for testing, not for
     real launch scale.
   - Pi Authentication: auto-triggers on page load AND via the
     manual "Sign in with Pi" button, per Pi Network's GenAI
     integration requirements. The access token is sent to a
     BACKEND endpoint for validation — see BACKEND_BASE_URL below.
     ⚠️ Until a real backend exists, this falls back to calling
     Pi's /v2/me endpoint directly from the browser so you can
     test end-to-end. THIS IS NOT SAFE FOR REAL LAUNCH: a modified
     client could skip validation entirely. Before going live,
     move this call to your own server (see validateWithBackend).
   - Persistence uses localStorage until this app is officially
     registered in Pi App Studio and can use its real multi-device
     persistent storage instead.
   ============================================================ */

const STORAGE_KEY = "pitalk_prefs_v1";

// ============================================================
// Peer-to-peer connection between two pioneers (PeerJS, free
// public broker, no account needed for the host or the joiner).
// Real voice goes directly between devices (WebRTC audio); each
// side's translated text is also sent over a data channel and
// shown as a caption, so translation doesn't depend on TTS.
// ============================================================
let peerConn = null;
let activeCall = null;
let dataConn = null;
let localCallStream = null;
let isCallHost = false;

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const ROOM_CODE_KEY = "pitalk_room_code_v1";
const ROOM_CODE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Keep the same room code for a full day, stored locally — otherwise a
// backgrounded mobile tab getting reloaded (common when switching to
// WhatsApp/SMS to send the code) would silently generate a brand new one.
function getOrCreateRoomCode() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_CODE_KEY) || "null");
    if (saved && saved.code && Date.now() - saved.createdAt < ROOM_CODE_TTL_MS) {
      return saved.code;
    }
  } catch {}
  const code = generateRoomCode();
  localStorage.setItem(ROOM_CODE_KEY, JSON.stringify({ code, createdAt: Date.now() }));
  return code;
}

function setConnectStatus(text, connected) {
  const el = document.getElementById("connectStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("connected", !!connected);
}

// Generates a short two-tone chime with the Web Audio API — no sound file
// needed, so it works reliably everywhere (unlike the translated-speech
// audio, which depends on a network fetch).
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.0001, now + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.18);
      osc.stop(now + i * 0.18 + 0.2);
    });
  } catch (err) {
    console.error("Chime failed:", err);
  }
}

function setupCallEvents() {
  activeCall.on("stream", (remoteStream) => {
    const remoteAudio = document.getElementById("remoteAudio");
    remoteAudio.srcObject = remoteStream;
    remoteAudio.play().catch(() => {});
    setConnectStatus("Connected — you can talk now", true);
    playChime();
    const ringBtn = document.getElementById("ringBtn");
    if (ringBtn) ringBtn.style.display = "inline-block";
  });
  activeCall.on("close", () => setConnectStatus("Call ended", false));
  activeCall.on("error", (err) => console.error("Call error:", err));
}

function setupDataConnEvents() {
  dataConn.on("data", (data) => {
    if (data && data.type === "caption") {
      transcript.innerHTML += `<p style="margin-top:.5rem;color:#9B5CE0;"><strong>Them:</strong> ${data.text}</p>`;
    } else if (data && data.type === "ring") {
      playChime();
      setConnectStatus("🔔 Your pioneer wants to talk!", true);
    } else if (data && data.type === "audio" && data.buffer) {
      try {
        const blob = new Blob([data.buffer], { type: "audio/mpeg" });
        const blobUrl = URL.createObjectURL(blob);
        const audio = new Audio(blobUrl);
        audio.onended = () => URL.revokeObjectURL(blobUrl);
        audio.play().catch((err) => console.error("Playback of received translation failed:", err));
      } catch (err) {
        console.error("Could not play received translation audio:", err);
      }
    } else if (typeof data === "string") {
      // Backward-compatible fallback for plain-text messages.
      transcript.innerHTML += `<p style="margin-top:.5rem;color:#9B5CE0;"><strong>Them:</strong> ${data}</p>`;
    }
  });
  dataConn.on("error", (err) => console.error("Data channel error:", err));
}

// Generates the spoken translation audio (StreamElements) and sends it to
// the connected pioneer over the data channel, so THEY hear the translation
// in their own language — the live call audio alone only carries your raw
// voice in your own language.
async function sendSpokenTranslation(text, targetLangObj) {
  const voice = STREAMELEMENTS_VOICES[targetLangObj.iso] || "Joanna";
  const url = `https://api.streamelements.com/kappa/v2/speech?voice=${voice}&text=${encodeURIComponent(text.slice(0, 500))}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Speech request failed: ${res.status}`);
    const buffer = await res.arrayBuffer();
    if (dataConn && dataConn.open) {
      dataConn.send({ type: "audio", buffer });
    }
  } catch (err) {
    console.error("Could not generate/send spoken translation:", err);
  }
}

async function startCall() {
  if (typeof Peer === "undefined") {
    alert("Calling isn't available right now — please reload the page.");
    return;
  }
  try {
    localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("Microphone access is needed to start a call.");
    return;
  }

  const code = getOrCreateRoomCode();
  const fullId = "pitalkglobal-" + code;
  isCallHost = true;
  peerConn = new Peer(fullId);

  peerConn.on("open", () => {
    document.getElementById("roomCodeText").textContent = code;
    document.getElementById("roomCodeDisplay").style.display = "block";
    setConnectStatus("Waiting for the other pioneer to join…", false);
    setupShareLinkButton(code);
  });

  peerConn.on("call", (incomingCall) => {
    incomingCall.answer(localCallStream);
    activeCall = incomingCall;
    setupCallEvents();
  });

  peerConn.on("connection", (conn) => {
    dataConn = conn;
    setupDataConnEvents();
  });

  peerConn.on("error", (err) => {
    console.error("Peer error:", err);
    if (err.type === "unavailable-id") {
      // A previous session with this same code is still registered
      // (e.g. this device didn't close cleanly) — show the code anyway
      // since it's still yours, just note the reconnect.
      document.getElementById("roomCodeText").textContent = code;
      document.getElementById("roomCodeDisplay").style.display = "block";
      setConnectStatus("Reconnecting to your existing room…", false);
      setupShareLinkButton(code);
    } else {
      setConnectStatus("Connection error — try again.", false);
    }
  });
}

async function joinCall(rawCode) {
  if (typeof Peer === "undefined") {
    alert("Calling isn't available right now — please reload the page.");
    return;
  }
  try {
    localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("Microphone access is needed to join a call.");
    return;
  }

  const fullId = "pitalkglobal-" + rawCode.trim().toUpperCase();
  isCallHost = false;
  peerConn = new Peer();

  peerConn.on("open", () => {
    setConnectStatus("Connecting…", false);
    activeCall = peerConn.call(fullId, localCallStream);
    setupCallEvents();
    dataConn = peerConn.connect(fullId);
    setupDataConnEvents();
  });

  peerConn.on("error", (err) => {
    console.error("Peer error:", err);
    setConnectStatus("Couldn't connect — check the code and try again.", false);
  });
}


const TRANSLATE_ENDPOINT = "https://api.mymemory.translated.net/get";

// TODO: replace with your real backend once it exists.
// Your backend should receive the accessToken, call
// GET https://api.minepi.com/v2/me with Authorization: Bearer <accessToken>,
// and only then create a session. No Pi API key is required for this call.
const BACKEND_BASE_URL = ""; // e.g. "https://your-backend.example.com"

const LANG_CODES = {
  "English": { bcp47: "en-US", iso: "en" },
  "French": { bcp47: "fr-FR", iso: "fr" },
  "Chinese (Mandarin)": { bcp47: "zh-CN", iso: "zh" },
};

let currentUser = null;
let piInitPromise = null;

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn("Failed to save preferences:", e);
  }
}

const micBtn = document.getElementById("micBtn");
const statusText = document.getElementById("phoneStatusText");
const statusDot = document.querySelector(".dot");
const transcript = document.getElementById("transcript");
const authBtn = document.getElementById("authBtn");
const clearBtn = document.getElementById("clearBtn");

function setStatus(text, color) {
  if (statusText) statusText.textContent = text;
  if (statusDot) statusDot.style.background = color;
}

// Wrap a promise so it fails loudly instead of hanging forever — outside the
// real Pi Browser, Pi.authenticate() can sit unresolved with no error at all.
function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
}

// ---- Pi SDK init, treated as a Promise so callers can fully await it ----
function ensurePiInit() {
  if (piInitPromise) return piInitPromise;
  piInitPromise = new Promise((resolve, reject) => {
    if (typeof Pi === "undefined") {
      reject(new Error("Pi SDK not available (not running inside the Pi Browser)."));
      return;
    }
    try {
      const result = Pi.init({ version: "2.0", sandbox: true }); // Testnet — matches this app's Developer Portal registration
      // Pi.init may or may not return a promise depending on SDK version — support both.
      Promise.resolve(result).then(resolve).catch(resolve);
    } catch (err) {
      reject(err);
    }
  });
  return piInitPromise;
}

// ---- Validate the access token before establishing a "session" client-side ----
async function validateWithBackend(accessToken) {
  if (BACKEND_BASE_URL) {
    const res = await fetch(`${BACKEND_BASE_URL}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken }),
    });
    if (!res.ok) throw new Error("Backend validation failed");
    return res.json();
  }

  // Temporary client-side fallback for testing only (see warning above).
  const res = await fetch("https://api.minepi.com/v2/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Pi token validation failed");
  return res.json();
}

const startCallBtn = document.getElementById("startCallBtn");
const joinCallBtn = document.getElementById("joinCallBtn");
const connectBtn = document.getElementById("connectBtn");
const joinCodeRow = document.getElementById("joinCodeRow");
const roomCodeInput = document.getElementById("roomCodeInput");

if (startCallBtn) {
  startCallBtn.addEventListener("click", () => {
    startCallBtn.classList.add("active");
    if (joinCodeRow) joinCodeRow.style.display = "none";
    startCall();
  });
}
if (joinCallBtn) {
  joinCallBtn.addEventListener("click", () => {
    joinCallBtn.classList.add("active");
    if (joinCodeRow) joinCodeRow.style.display = "flex";
  });
}
if (connectBtn) {
  connectBtn.addEventListener("click", () => {
    const code = roomCodeInput ? roomCodeInput.value : "";
    if (code.trim()) joinCall(code);
  });
}

function setupShareLinkButton(code) {
  const shareBtn = document.getElementById("shareLinkBtn");
  if (!shareBtn) return;
  const link = `${window.location.origin}${window.location.pathname}?room=${code}`;

  shareBtn.onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join me on PiTalk Global",
          text: "Tap to join our real-time translated call:",
          url: link,
        });
        return;
      } catch (err) {
        // User cancelled the share sheet, or it failed — fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      shareBtn.textContent = "✅ Link copied!";
      setTimeout(() => (shareBtn.textContent = "📤 Share invite link"), 2000);
    } catch (err) {
      alert(`Copy this link:\n${link}`);
    }
  };
}

// If this page was opened via a shared invite link (?room=CODE), jump
// straight into joining that call instead of showing the start/join menu.
function checkForInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room && roomCodeInput && joinCodeRow) {
    roomCodeInput.value = room;
    joinCodeRow.style.display = "flex";
    if (joinCallBtn) joinCallBtn.classList.add("active");
    joinCall(room);
  }
}
checkForInviteLink();

const ringBtn = document.getElementById("ringBtn");
if (ringBtn) {
  ringBtn.addEventListener("click", () => {
    playChime();
    if (dataConn && dataConn.open) {
      dataConn.send({ type: "ring" });
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const prefs = loadPrefs();

  if (!prefs.onboarded && !window.location.pathname.includes("onboarding.html")) {
    window.location.href = "onboarding.html";
    return;
  }

  const langYou = document.getElementById("langYou");
  const langThem = document.getElementById("langThem");

  if (langYou && prefs.langYou) langYou.value = prefs.langYou;
  if (langThem && prefs.langThem) langThem.value = prefs.langThem;

  const eyebrow = document.querySelector(".eyebrow");
  if (eyebrow && prefs.displayName) {
    eyebrow.textContent = `Welcome back, ${prefs.displayName} · Real-time voice translation`;
  }

  if (langYou && langThem) {
    [langYou, langThem].forEach((sel) => {
      sel.addEventListener("change", () => {
        savePrefs({ ...loadPrefs(), langYou: langYou.value, langThem: langThem.value });
      });
    });
  }

  if (prefs.activePlan) {
    const activeBtn = document.querySelector(`.btn--plan[data-plan="${prefs.activePlan}"]`);
    if (activeBtn) activeBtn.textContent = "Subscribed ✓";
  }

  // Auto-trigger Pi authentication on load (silent — no alert if unavailable/declined)
  signInWithPi({ silent: true });
});

const tryDemoBtn = document.getElementById("tryDemoBtn");
if (tryDemoBtn) {
  tryDemoBtn.addEventListener("click", () => {
    const demoSection = document.getElementById("demo");
    if (demoSection) demoSection.scrollIntoView({ behavior: "smooth" });
  });
}

// Real spoken output via a free TTS endpoint (StreamElements — no account, no
// key, no sign-in required for the end user) that returns an actual playable
// audio file. This avoids depending on the device's own voice engine, which
// the Pi Browser's WebView often lacks. Note: this is an unofficial, free
// community endpoint, not a documented paid service — fine for testing, but
// should be replaced with a proper paid TTS provider before a real launch.
const STREAMELEMENTS_VOICES = { en: "Joanna", fr: "Celine", zh: "Zhiyu" };

async function speakTranslation(translatedText, targetLangObj) {
  const voice = STREAMELEMENTS_VOICES[targetLangObj.iso] || "Joanna";
  const url = `https://api.streamelements.com/kappa/v2/speech?voice=${voice}&text=${encodeURIComponent(translatedText.slice(0, 500))}`;

  try {
    setStatus("Speaking output…", "#5EE0A0");
    // Fetch the audio bytes ourselves (like our translation requests already
    // do successfully) instead of pointing <audio> straight at the remote
    // URL — some WebViews (Pi Browser included, it seems) restrict direct
    // JS-initiated cross-origin media loads even though a plain page
    // navigation to the same URL works fine.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Speech request failed: ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      const audio = new Audio(blobUrl);
      audio.onended = () => {
        URL.revokeObjectURL(blobUrl);
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        reject(new Error("Blob audio playback failed"));
      };
      audio.play().catch(reject);
    });
    return;
  } catch (err) {
    console.error("Cloud speech (StreamElements) failed, falling back to device voice:", err);
  }

  // Fallback: the device/browser's own voice engine, if it has one.
  if ("speechSynthesis" in window) {
    const voices = window.speechSynthesis.getVoices();
    const targetPrefix = targetLangObj.bcp47.split("-")[0].toLowerCase();
    const matchingVoice = voices.find(
      (v) => v.lang && v.lang.toLowerCase().startsWith(targetPrefix)
    );

    await new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(translatedText);
      utter.lang = targetLangObj.bcp47;
      utter.rate = 0.88;
      if (matchingVoice) utter.voice = matchingVoice;
      utter.onstart = () => setStatus("Speaking output…", "#5EE0A0");
      utter.onend = resolve;
      utter.onerror = () => {
        transcript.innerHTML += `<p style="margin-top:.5rem;color:rgba(255,255,255,.5);font-size:.82rem;">🔇 Spoken playback isn't available right now — showing translation as text only.</p>`;
        resolve();
      };
      window.speechSynthesis.speak(utter);
      setTimeout(resolve, 5000); // safety net if neither event ever fires
    });
  } else {
    transcript.innerHTML += `<p style="margin-top:.5rem;color:rgba(255,255,255,.5);font-size:.82rem;">🔇 No spoken playback available on this device — text translation only.</p>`;
  }
}

// MyMemory truncates/rejects long queries, so split into sentence-sized
// chunks and translate each in turn — this avoids ever cutting off mid-
// sentence on longer conversations (multiple speak/pause turns before End).
async function translateLongText(text, sourceLang, targetLang) {
  const sentences = text.match(/[^.!?]+[.!?]*(\s+|$)/g) || [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > 450 && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const translatedParts = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      q: chunk.slice(0, 500),
      langpair: `${sourceLang}|${targetLang}`,
    });
    const res = await fetch(`${TRANSLATE_ENDPOINT}?${params}`);
    const data = await res.json();
    if (data.responseStatus !== 200 || !data.responseData) {
      throw new Error(data.responseDetails || "Translation failed");
    }
    translatedParts.push(data.responseData.translatedText);
  }
  return translatedParts.join(" ");
}
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
const endBtn = document.getElementById("endBtn");
const micHint = document.getElementById("micHint");
let recognition = null;
let recognizedText = "";
let finalTranscript = "";
let micState = "idle"; // idle | listening | paused
let speechUnlocked = false;

// Many mobile browsers only allow speechSynthesis.speak() if it has been
// called at least once directly inside a user gesture (tap). Our real speak()
// call happens later, after an async translation request, which can be too
// late for some mobile WebViews (like the one inside Pi Browser) — so we
// "prime" the speech engine here, synchronously, on the very first tap.
function unlockSpeechSynthesis() {
  if (speechUnlocked || !("speechSynthesis" in window)) return;
  const primer = new SpeechSynthesisUtterance(" ");
  primer.volume = 0;
  window.speechSynthesis.speak(primer);
  speechUnlocked = true;
}

let audioUnlocked = false;
// Same idea as unlockSpeechSynthesis, but for <audio>/StreamElements playback:
// many browsers only allow audio.play() when it's directly tied to a user
// gesture. Our real playback happens after an async translation request,
// which is too late — so we "unlock" it here with a silent clip, played
// synchronously inside the very first tap (like YouTube's one-time "unmute").
function unlockAudioPlayback() {
  if (audioUnlocked) return;
  const silence = new Audio(
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
  );
  silence.volume = 0.01;
  silence.play().catch(() => {});
  audioUnlocked = true;
}

// Chrome's "continuous" mode silently restarts its internal session every so
// often, resetting result indices to 0 — accumulating on top of that caused
// text to repeat and grow. Instead, we run short single-utterance sessions
// (continuous: false) and explicitly restart them ourselves on `onend` while
// we're still in the "listening" state, appending each session's final text
// exactly once. Tapping pauses this cleanly; a separate End button finalizes.
function startRecognitionSession(bcp47Lang) {
  recognition = new SpeechRecognitionAPI();
  recognition.lang = bcp47Lang;
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onresult = (event) => {
    let interimText = "";
    for (let i = 0; i < event.results.length; i++) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        if (!finalTranscript.endsWith(piece.trim())) {
          finalTranscript += piece + " ";
        }
      } else {
        interimText += piece;
      }
    }
    recognizedText = (finalTranscript + interimText).trim();
    transcript.innerHTML = `<p><strong>You:</strong> ${recognizedText}</p>`;
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
  };

  recognition.onend = () => {
    if (micState === "listening") {
      // Still in listening state — start a fresh session to keep going.
      startRecognitionSession(bcp47Lang);
    }
  };

  try {
    recognition.start();
  } catch (err) {
    console.error("Could not start recognition:", err);
  }
}

function startListening() {
  if (!SpeechRecognitionAPI) {
    alert("Your browser doesn't support live voice recognition. Please test in Chrome.");
    return;
  }

  unlockSpeechSynthesis();
  unlockAudioPlayback();

  const langYouSel = document.getElementById("langYou");
  const youLang = LANG_CODES[langYouSel.value] || LANG_CODES["English"];

  micState = "listening";
  startRecognitionSession(youLang.bcp47);

  micBtn.classList.add("recording");
  micBtn.classList.remove("paused");
  setStatus("Listening…", "#F5C36B");
  if (micHint) micHint.textContent = "Tap to pause";
  if (endBtn) endBtn.style.display = "inline-block";
  if (!finalTranscript) {
    transcript.innerHTML = `<p class="transcript__placeholder">Listening… speak now.</p>`;
  }
}

function pauseListening() {
  micState = "paused";
  if (recognition) recognition.stop();

  micBtn.classList.remove("recording");
  micBtn.classList.add("paused");
  setStatus("Paused", "#9B5CE0");
  if (micHint) micHint.textContent = "Tap to resume · End when done";
}

function handleMicTap(e) {
  e.preventDefault();
  if (micState === "idle" || micState === "paused") {
    startListening();
  } else if (micState === "listening") {
    pauseListening();
  }
}

async function endConversation() {
  micState = "idle";
  if (recognition) recognition.stop();
  micBtn.classList.remove("recording", "paused");
  if (endBtn) endBtn.style.display = "none";
  if (micHint) micHint.textContent = "Tap to start talking";

  // Collapse immediate word repeats (e.g. "alors alors" -> "alors") — some
  // browsers finalize the same short word twice at a pause.
  const text = finalTranscript.trim().replace(/(\p{L}+)(\s+\1\b)+/giu, "$1");
  finalTranscript = "";
  recognizedText = "";

  if (!text) {
    setStatus("Ready", "#5EE0A0");
    transcript.innerHTML = `<p class="transcript__placeholder">Your live transcript will appear here during a call.</p>`;
    return;
  }

  setStatus("Translating…", "#9B5CE0");

  const langYouSel = document.getElementById("langYou");
  const langThemSel = document.getElementById("langThem");
  const sourceLang = (LANG_CODES[langYouSel.value] || LANG_CODES["English"]).iso;
  const targetLangObj = LANG_CODES[langThemSel.value] || LANG_CODES["French"];
  const targetLang = targetLangObj.iso;

  try {
    const translated = await translateLongText(text, sourceLang, targetLang);

    transcript.innerHTML = `<p><strong>You:</strong> ${text}</p><p style="margin-top:.6rem;color:#F5C36B;"><strong>Translation:</strong> ${translated}</p><p style="margin-top:.6rem;color:rgba(255,255,255,.4);font-size:.78rem;letter-spacing:.05em;">— END / FIN —</p>`;
    if (clearBtn) clearBtn.style.display = "inline-block";

    if (dataConn && dataConn.open) {
      // In a live call: the translation is meant for the OTHER pioneer to
      // hear in their language — send the caption and spoken audio to them
      // instead of playing/showing it only on this device.
      dataConn.send({ type: "caption", text: translated });
      setStatus("Sending translation…", "#9B5CE0");
      await sendSpokenTranslation(translated, targetLangObj);
      setStatus("Ready", "#5EE0A0");
    } else {
      setStatus("Sending to speaker…", "#9B5CE0");
      await speakTranslation(translated, targetLangObj);
      setStatus("Ready", "#5EE0A0");
    }
  } catch (err) {
    console.error("Translation request failed:", err);
    transcript.innerHTML = `<p><strong>You:</strong> ${text}</p><p style="margin-top:.6rem;color:#E8546B;">Translation service unavailable right now — try again in a moment.</p>`;
    setStatus("Ready", "#5EE0A0");
  }
}

if (micBtn) {
  micBtn.addEventListener("click", handleMicTap);
}
if (endBtn) {
  endBtn.addEventListener("click", (e) => {
    e.preventDefault();
    endConversation();
  });
}

if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    transcript.innerHTML = `<p class="transcript__placeholder">Your live transcript will appear here during a call.</p>`;
    clearBtn.style.display = "none";
    setStatus("Ready", "#5EE0A0");
  });
}

// ---- Swap "You speak" / "They hear" languages ----
const swapBtn = document.getElementById("swapBtn");
if (swapBtn) {
  swapBtn.addEventListener("click", () => {
    const langYouSel = document.getElementById("langYou");
    const langThemSel = document.getElementById("langThem");
    if (!langYouSel || !langThemSel) return;

    const temp = langYouSel.value;
    langYouSel.value = langThemSel.value;
    langThemSel.value = temp;

    savePrefs({ ...loadPrefs(), langYou: langYouSel.value, langThem: langThemSel.value });
  });
}

// ---- Pi Authentication ----
// Per Pi Network's integration requirements: Pi.init() is awaited as a
// Promise before Pi.authenticate() runs, the "username" scope is used for
// general sign-in, and the access token is validated (ideally server-side)
// before a session is established.
function onIncompletePaymentFound(payment) {
  console.log("Incomplete payment found:", payment);
}

async function signInWithPi({ silent = false } = {}) {
  if (typeof Pi === "undefined") {
    if (!silent) alert("Open this app inside the Pi Browser to sign in with Pi.");
    return null;
  }
  try {
    await withTimeout(ensurePiInit(), 6000, "Pi SDK init timed out — not running inside the Pi Browser.");
    const auth = await withTimeout(
      Pi.authenticate(["username"], onIncompletePaymentFound),
      10000,
      "Pi sign-in timed out — this only works inside the real Pi Browser."
    );

    // Validate the token BEFORE treating the user as signed in.
    await validateWithBackend(auth.accessToken);

    currentUser = auth.user;
    if (authBtn) authBtn.textContent = `Hi, ${auth.user.username}`;
    return auth.user;
  } catch (err) {
    console.error("Pi authentication failed:", err);
    if (!silent) alert("Sign-in didn't complete. Open this app inside the real Pi Browser and try again.");
    return null;
  }
}

if (authBtn) {
  authBtn.addEventListener("click", () => signInWithPi({ silent: false }));
}

// ---- Subscription payments (requires the extra "payments" scope) ----
async function signInForPayments() {
  await withTimeout(ensurePiInit(), 6000, "Pi SDK init timed out — not running inside the Pi Browser.");
  const auth = await withTimeout(
    Pi.authenticate(["username", "payments"], onIncompletePaymentFound),
    10000,
    "Pi sign-in timed out — this only works inside the real Pi Browser."
  );
  await validateWithBackend(auth.accessToken);
  currentUser = auth.user;
  if (authBtn) authBtn.textContent = `Hi, ${auth.user.username}`;
  return auth.user;
}

document.querySelectorAll(".btn--plan").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (typeof Pi === "undefined") {
      alert("Open this app inside the Pi Browser to subscribe with Pi.");
      return;
    }

    try {
      await signInForPayments();
    } catch (err) {
      console.error("Payment sign-in failed:", err);
      alert("Sign-in failed. Please try again from the Pi Browser.");
      return;
    }

    const plan = btn.dataset.plan;
    const amount = parseFloat(btn.dataset.amount);
    const originalLabel = btn.textContent;
    btn.textContent = "Processing…";
    btn.disabled = true;

    try {
      await Pi.createPayment(
        {
          amount: amount,
          memo: `PiTalk Global — ${plan} plan`,
          metadata: { plan },
        },
        {
          onReadyForServerApproval: (paymentId) => {
            console.log("Send to backend for approval:", paymentId);
          },
          onReadyForCompletion: (paymentId, txid) => {
            console.log("Send to backend for completion:", paymentId, txid);
            savePrefs({ ...loadPrefs(), activePlan: plan, subscribedAt: Date.now() });
            btn.textContent = "Subscribed ✓";
          },
          onCancel: (paymentId) => {
            console.log("Payment cancelled:", paymentId);
            btn.textContent = originalLabel;
            btn.disabled = false;
          },
          onError: (error, payment) => {
            console.error("Payment error:", error, payment);
            btn.textContent = originalLabel;
            btn.disabled = false;
          },
        }
      );
    } catch (err) {
      console.error("createPayment failed:", err);
      btn.textContent = originalLabel;
      btn.disabled = false;
    }
  });
});
