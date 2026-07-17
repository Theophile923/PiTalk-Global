/* ============================================================
   PiTalk Global — front-end shell (Optimized)
   NOTE FOR GOODHOPE:
   - The mic below records and plays back your own voice for
     real push-to-talk testing. It is NOT wired to a real
     translation engine yet — the translated line is a labeled
     placeholder until STT/MT/TTS is built.
   - Persistence uses localStorage until this app is officially
     registered in Pi App Studio (blocked on KYC) and can use
     App Studio's real multi-device persistent storage instead.
   ============================================================ */

const STORAGE_KEY = "pitalk_prefs_v1";

let mediaRecorder = null;
let audioChunks = [];
let micStream = null;
let demoIndex = 0;
let currentUser = null;
let currentAudioUrl = null;

const DEMO_TRANSLATIONS = [
  "Quel est votre meilleur prix pour 50 unités ?",
  "Nous pouvons livrer sous cinq jours.",
  "Pouvons-nous nous mettre d'accord aujourd'hui ?",
];

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

async function startRecording(e) {
  e.preventDefault();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("This browser can't access the microphone. Try the Pi Browser or a recent Chrome/Safari version.");
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("Microphone access wasn't granted. Please allow microphone permission and try again.");
    return;
  }

  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
  }

  audioChunks = [];
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (ev) => audioChunks.push(ev.data);
  mediaRecorder.start();

  micBtn.classList.add("recording");
  setStatus("Listening…", "#F5C36B");
  transcript.innerHTML = `<p class="transcript__placeholder">Recording… release the button when you're done.</p>`;
}

function stopRecording(e) {
  if (e) e.preventDefault();
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;

  micBtn.classList.remove("recording");
  mediaRecorder.stop();

  mediaRecorder.onstop = () => {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
    }

    const blob = new Blob(audioChunks, { type: "audio/webm" });
    currentAudioUrl = URL.createObjectURL(blob);

    setStatus("Translating…", "#9B5CE0");
    transcript.innerHTML = `<p><strong>Your recording:</strong></p><audio controls src="${currentAudioUrl}" style="width:100%;margin:.4rem 0 0;"></audio>`;

    const line = DEMO_TRANSLATIONS[demoIndex % DEMO_TRANSLATIONS.length];
    demoIndex++;

    setTimeout(() => {
      setStatus("Speaking output…", "#5EE0A0");
      transcript.innerHTML += `<p style="margin-top:.6rem;color:#F5C36B;"><strong>Simulated translation (not real yet):</strong> ${line}</p>`;
      if (clearBtn) clearBtn.style.display = "inline-block";
    }, 1000);

    setTimeout(() => setStatus("Ready", "#5EE0A0"), 2000);
  };
}

if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = null;
    }
    transcript.innerHTML = `<p class="transcript__placeholder">Your live transcript will appear here during a call.</p>`;
    clearBtn.style.display = "none";
    setStatus("Ready", "#5EE0A0");
  });
}

if (micBtn) {
  micBtn.addEventListener("mousedown", startRecording);
  micBtn.addEventListener("touchstart", startRecording, { passive: false });
  micBtn.addEventListener("mouseup", stopRecording);
  micBtn.addEventListener("mouseleave", stopRecording);
  micBtn.addEventListener("touchend", stopRecording, { passive: false });
}

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
