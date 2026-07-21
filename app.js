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

// ---- Pi SDK init, treated as a Promise so callers can fully await it ----
function ensurePiInit() {
  if (piInitPromise) return piInitPromise;
  piInitPromise = new Promise((resolve, reject) => {
    if (typeof Pi === "undefined") {
      reject(new Error("Pi SDK not available (not running inside the Pi Browser)."));
      return;
    }
    try {
      const result = Pi.init({ version: "2.0", sandbox: false });
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

// ---- Real speech recognition -> translation -> spoken output ----
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizedText = "";
let finalTranscript = "";
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

function startRecording(e) {
  e.preventDefault();

  if (!SpeechRecognitionAPI) {
    alert("Your browser doesn't support live voice recognition. Please test in Chrome.");
    return;
  }

  unlockSpeechSynthesis();

  const langYouSel = document.getElementById("langYou");
  const youLang = LANG_CODES[langYouSel.value] || LANG_CODES["English"];

  recognizedText = "";
  finalTranscript = "";
  recognition = new SpeechRecognitionAPI();
  recognition.lang = youLang.bcp47;
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (event) => {
    let interimText = "";
    // Only walk NEW results since the last event (event.resultIndex),
    // and append each final chunk exactly once — reprocessing the whole
    // results array from 0 every time was duplicating/repeating text.
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += piece + " ";
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

  try {
    recognition.start();
  } catch (err) {
    console.error("Could not start recognition:", err);
    return;
  }

  micBtn.classList.add("recording");
  setStatus("Listening…", "#F5C36B");
  transcript.innerHTML = `<p class="transcript__placeholder">Listening… speak now.</p>`;
}

async function stopRecording(e) {
  if (e) e.preventDefault();
  if (!recognition) return;

  recognition.stop();
  micBtn.classList.remove("recording");
  setStatus("Translating…", "#9B5CE0");

  setTimeout(async () => {
    const text = recognizedText.trim();

    if (!text) {
      setStatus("Ready", "#5EE0A0");
      transcript.innerHTML = `<p class="transcript__placeholder">Didn't catch that — hold the button and try again.</p>`;
      return;
    }

    const langYouSel = document.getElementById("langYou");
    const langThemSel = document.getElementById("langThem");
    const sourceLang = (LANG_CODES[langYouSel.value] || LANG_CODES["English"]).iso;
    const targetLangObj = LANG_CODES[langThemSel.value] || LANG_CODES["French"];
    const targetLang = targetLangObj.iso;

    try {
      const params = new URLSearchParams({
        q: text.slice(0, 500),
        langpair: `${sourceLang}|${targetLang}`,
      });
      const res = await fetch(`${TRANSLATE_ENDPOINT}?${params}`);
      const data = await res.json();

      if (data.responseStatus !== 200 || !data.responseData) {
        throw new Error(data.responseDetails || "Translation failed");
      }
      const translated = data.responseData.translatedText;

      setStatus("Speaking output…", "#5EE0A0");
      transcript.innerHTML = `<p><strong>You:</strong> ${text}</p><p style="margin-top:.6rem;color:#F5C36B;"><strong>Translation:</strong> ${translated}</p>`;
      if (clearBtn) clearBtn.style.display = "inline-block";

      if ("speechSynthesis" in window) {
        const utter = new SpeechSynthesisUtterance(translated);
        utter.lang = targetLangObj.bcp47;
        window.speechSynthesis.speak(utter);
      }
    } catch (err) {
      console.error("Translation request failed:", err);
      transcript.innerHTML = `<p><strong>You:</strong> ${text}</p><p style="margin-top:.6rem;color:#E8546B;">Translation service unavailable right now — try again in a moment.</p>`;
    }

    setTimeout(() => setStatus("Ready", "#5EE0A0"), 500);
  }, 400);
}

if (micBtn) {
  micBtn.addEventListener("mousedown", startRecording);
  micBtn.addEventListener("touchstart", startRecording, { passive: false });
  micBtn.addEventListener("mouseup", stopRecording);
  micBtn.addEventListener("mouseleave", stopRecording);
  micBtn.addEventListener("touchend", stopRecording, { passive: false });
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
    await ensurePiInit();
    const auth = await Pi.authenticate(["username"], onIncompletePaymentFound);

    // Validate the token BEFORE treating the user as signed in.
    await validateWithBackend(auth.accessToken);

    currentUser = auth.user;
    if (authBtn) authBtn.textContent = `Hi, ${auth.user.username}`;
    return auth.user;
  } catch (err) {
    console.error("Pi authentication failed:", err);
    if (!silent) alert("Sign-in failed. Please try again from the Pi Browser.");
    return null;
  }
}

if (authBtn) {
  authBtn.addEventListener("click", () => signInWithPi({ silent: false }));
}

// ---- Subscription payments (requires the extra "payments" scope) ----
async function signInForPayments() {
  await ensurePiInit();
  const auth = await Pi.authenticate(["username", "payments"], onIncompletePaymentFound);
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
