// js/email.js — AES Fire & Rescue Operations Leave System v2
const EMAILJS_SERVICE_ID  = "service_lc6s4ic";
const EMAILJS_TEMPLATE_ID = "template_zxhlibm";
const EMAILJS_PUBLIC_KEY  = "eCMDH8Zet7iq8so8M";

function loadEmailJS() {
  return new Promise((resolve) => {
    if (window.emailjs) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
    s.onload = () => { window.emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY }); resolve(); };
    document.head.appendChild(s);
  });
}

export async function sendEmail(to_email, subject, message) {
  if (!to_email) return;
  try {
    await loadEmailJS();
    await window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email, subject, message, name: "AES Fire & Rescue — Leave System"
    });
  } catch(err) { console.warn("Email failed:", to_email, err); }
}

export async function sendEmailToAll(emails, subject, message) {
  for (const email of emails.filter(Boolean)) {
    await sendEmail(email, subject, message);
  }
}
