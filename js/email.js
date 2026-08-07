// js/email.js — AES Leave Management System

const EMAILJS_SERVICE_ID  = "service_lc6s4ic";
const EMAILJS_TEMPLATE_ID = "template_zxhlibm";
const EMAILJS_PUBLIC_KEY  = "eCMDH8Zet7iq8so8M";

// Load EmailJS SDK once
function loadEmailJS() {
  return new Promise((resolve) => {
    if (window.emailjs) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
    script.onload = () => {
      window.emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
      resolve();
    };
    document.head.appendChild(script);
  });
}

// Send single email
export async function sendEmail(to_email, subject, message) {
  if (!to_email) return;
  try {
    await loadEmailJS();
    await window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email,
      subject,
      message,
      name: "AES Leave System"
    });
    console.log("Email sent to:", to_email);
  } catch(err) {
    console.warn("Email failed:", err);
  }
}
