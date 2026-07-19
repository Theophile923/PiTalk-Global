/* ============================================================
   PiTalk Global — front-end shell
   NOTE FOR GOODHOPE:
   - Minimal working MVP: real speech recognition, real machine
     translation, real spoken output — for English <-> French
     (and Chinese, best-effort) using free browser + public APIs.
   - Speech recognition & speech synthesis use the browser's
     built-in Web Speech API (Chrome only, reliable). Audio you
     speak is sent to the browser vendor's recognition service —
     this is a browser feature, not something PiTalk Global
     stores or controls.
   - Translation uses the public LibreTranslate API. That public
     instance is meant for testing/personal use, not high-volume
     production — get a paid API key before real launch.
   - Persistence uses localStorage until this app is officially
     registered in Pi App Studio (blocked on KYC) and can use
     App Studio's real multi-device persistent storage instead.
   ============================================================ */

const STORAGE_KEY = "pitalk_prefs_v1";
const TRANSLATE_ENDPOINT = "https://libretranslate.com/translate";

const LANG_CODES = {
  "English": { bcp47: "en-US", iso: "en" },
  "French": { bcp47: "fr-FR", iso: "fr" },
  "Chinese (Mandarin)": { bcp47: "zh-CN", iso: "zh" },
};

let currentUser = null;

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

document.addEventListener("DOMContentLoaded", () => {
  const prefs = loadPrefs();

  if (!prefs.onboarded && !window.location.pathname.includes("onboarding.html")) {
    window.location.href = "onboarding.html";
    return;
  }

  if (typeof Pi !== "undefined") {
    try {
      Pi.init({ version: "2.0", sandbox: false });
    } catch (err) {
      console.error("Pi SDK initialization failed:", err);
    }
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

function startRecording(e) {
  e.preventDefault();

  if (!SpeechRecognitionAPI) {
    alert("Your browser doesn't support live voice recognition. Please test in Chrome.");
    return;
  }

  const langYouSel = document.getElementById("langYou");
  const youLang = LANG_CODES[langYouSel.value] || LANG_CODES["English"];

  recognizedText = "";
  recognition = new SpeechRecognitionAPI();
  recognition.lang = youLang.bcp47;
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = 0; i < event.results.length; i++) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += piece;
      else interimText += piece;
    }
    recognizedText = (finalText + " " + interimText).trim();
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

  // Small delay so the final onresult event has time to land
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
      const res = await fetch(TRANSLATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, source: sourceLang, target: targetLang, format: "text" }),
      });
      const data = await res.json();
      const translated = data.translatedText || "(no translation returned)";

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

// ---- Pi Authentication ----
function onIncompletePaymentFound(payment) {
  console.log("Incomplete payment found:", payment);
}

async function signInWithPi() {
  if (typeof Pi === "undefined") {
    alert("Open this app inside the Pi Browser to sign in with Pi.");
    return null;
  }
  try {
    const scopes = ["username", "payments"];
    const auth = await Pi.authenticate(scopes, onIncompletePaymentFound);
    currentUser = auth.user;
    if (authBtn) authBtn.textContent = `Hi, ${auth.user.username}`;
    return auth.user;
  } catch (err) {
    console.error("Pi authentication failed:", err);
    alert("Sign-in failed. Please try again from the Pi Browser.");
    return null;
  }
}

if (authBtn) {
  authBtn.addEventListener("click", signInWithPi);
}

// ---- Subscription payments ----
document.querySelectorAll(".btn--plan").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (typeof Pi === "undefined") {
      alert("Open this app inside the Pi Browser to subscribe with Pi.");
      return;
    }
    if (!currentUser) {
      const user = await signInWithPi();
      if (!user) return;
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
