import { auth, db } from "./firebase.js";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Sign out any existing session when landing on login page
// so user always has to log in manually
signOut(auth).catch(() => {});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("loginError");
  const btn   = document.getElementById("loginBtn");
  errEl.textContent = "";
  btn.querySelector(".btn-text").textContent = "Signing in…";
  btn.querySelector(".btn-loader").style.display = "inline";
  btn.disabled = true;

  try {
    const email = document.getElementById("loginEmail").value.trim();
    const pass  = document.getElementById("loginPassword").value;
    const cred  = await signInWithEmailAndPassword(auth, email, pass);
    const role  = await getRole(cred.user.uid);
    redirect(role);
  } catch {
    errEl.textContent = "Incorrect email or password.";
    btn.querySelector(".btn-text").textContent = "Sign In";
    btn.querySelector(".btn-loader").style.display = "none";
    btn.disabled = false;
  }
});

async function getRole(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? (snap.data().role || "staff") : "staff";
  } catch { return "staff"; }
}

function redirect(role) {
  if (["officer","fire_admin","head_ops"].includes(role)) {
    window.location.href = "pages/manager.html";
  } else {
    window.location.href = "pages/staff.html";
  }
}

document.getElementById("togglePw").addEventListener("click", () => {
  const inp = document.getElementById("loginPassword");
  inp.type = inp.type === "password" ? "text" : "password";
});
