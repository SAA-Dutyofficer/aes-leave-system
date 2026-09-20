// js/auth.js
import { auth, db } from "./firebase.js";
import { signInWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Auto-redirect if already logged in
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const role = await getRole(user.uid);
    redirect(role);
  } catch { return; }
});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("loginError");
  const btn   = document.getElementById("loginBtn");
  errEl.textContent = "";
  btn.querySelector(".btn-text").textContent = "Signing in…";
  btn.querySelector(".btn-loader").style.display = "inline-block";
  btn.disabled = true;

  try {
    const email = document.getElementById("loginEmail").value.trim();
    const pass  = document.getElementById("loginPassword").value;
    const cred  = await signInWithEmailAndPassword(auth, email, pass);
    const role  = await getRole(cred.user.uid);
    redirect(role);
  } catch(err) {
    const code = err.code;
    errEl.textContent =
      (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found")
        ? "Incorrect email or password."
        : code === "auth/too-many-requests"
        ? "Too many attempts. Please try again later."
        : "Sign in failed. Please try again.";
    btn.querySelector(".btn-text").textContent = "Sign In";
    btn.querySelector(".btn-loader").style.display = "none";
    btn.disabled = false;
  }
});

// Forgot password
document.getElementById("forgotLink")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("loginView").style.display  = "none";
  document.getElementById("resetView").style.display  = "block";
  const email = document.getElementById("loginEmail").value.trim();
  if (email) document.getElementById("resetEmail").value = email;
});

document.getElementById("backToLogin")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("resetView").style.display  = "none";
  document.getElementById("loginView").style.display  = "block";
  document.getElementById("resetMsg").textContent = "";
});

document.getElementById("resetForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email  = document.getElementById("resetEmail").value.trim();
  const msgEl  = document.getElementById("resetMsg");
  msgEl.textContent = "";
  try {
    await sendPasswordResetEmail(auth, email);
    msgEl.className = "reset-success";
    msgEl.textContent = "Reset link sent — check your inbox.";
  } catch(err) {
    msgEl.className = "reset-error";
    msgEl.textContent = err.code === "auth/user-not-found"
      ? "No account found with this email."
      : "Failed to send. Please try again.";
  }
});

// Toggle password visibility
document.getElementById("togglePw").addEventListener("click", () => {
  const inp = document.getElementById("loginPassword");
  const icon = document.getElementById("togglePw");
  inp.type = inp.type === "password" ? "text" : "password";
  icon.textContent = inp.type === "password" ? "👁" : "🙈";
});

async function getRole(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? (snap.data().role || "staff") : "staff";
}

function redirect(role) {
  const approvers = ["officer","supervisor","fire_admin","section_head","director","superadmin"];
  window.location.href = approvers.includes(role) ? "pages/manager.html" : "pages/staff.html";
}
