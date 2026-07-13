import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBuOsM7NyqWdZf0WrieMe_eFTDjgFvGI70",
  authDomain: "aes-leave-system.firebaseapp.com",
  projectId: "aes-leave-system",
  storageBucket: "aes-leave-system.firebasestorage.app",
  messagingSenderId: "358624876237",
  appId: "1:358624876237:web:779ca2e8a53997418f3b84"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === 'failed-precondition') console.warn('Offline persistence: multiple tabs open');
  else if (err.code === 'unimplemented') console.warn('Offline persistence not supported');
});

window.addEventListener('online',  () => document.querySelectorAll('.offline-dot,.offline-indicator').forEach(el => el.style.display = 'none'));
window.addEventListener('offline', () => {
  document.querySelectorAll('.offline-dot').forEach(el => el.style.display = 'inline');
  document.querySelectorAll('.offline-indicator').forEach(el => el.style.display = 'block');
});
