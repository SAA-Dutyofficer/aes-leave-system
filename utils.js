// js/utils.js — AES Leave Management System

export const LEAVE_TYPES = [
  "Annual Leave",
  "Unpaid Leave",
  "Sick Leave",
  "Emergency Leave",
  "Compassionate Leave",
  "National Service",
  "Exam Leave"
];

export const SHIFT_GROUPS = ["White", "Red", "Black", "Green"];
export const GD_SECTIONS  = ["AES Management", "LFS", "L&D", "Admin", "Logistics", "EP&S"];
export const ALL_GROUPS   = [...SHIFT_GROUPS, ...GD_SECTIONS];

export const ROLES = {
  staff:      "Staff",
  officer:    "Officer",
  fire_admin: "Fire Admin",
  head_ops:   "Head of Operations"
};

// ── Date helpers ─────────────────────────────────────────────────
export function fmtDate(str) {
  if (!str) return "--";
  const d = new Date(str + "T00:00:00");
  if (isNaN(d)) return str;
  return d.toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"2-digit" });
}

export function fmtDateTime(ts) {
  if (!ts) return "--";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"2-digit",
    hour:"2-digit", minute:"2-digit" });
}

export function todayStr() {
  return new Date().toISOString().split("T")[0];
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

export function cycleEnd(cycleStart) {
  const d = new Date(cycleStart + "T00:00:00");
  d.setFullYear(d.getFullYear() + 1);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

// ── Working day checks ───────────────────────────────────────────
export function isGDWorkDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const wd = d.getDay();
  return wd >= 1 && wd <= 4; // Mon–Thu
}

// Shift pattern: 4W4O cycle
export function isShiftWorkDay(dateStr, rosterStart) {
  if (!rosterStart) return false;
  const d = new Date(dateStr + "T00:00:00");
  const r = new Date(rosterStart + "T00:00:00");
  const diff = Math.round((d - r) / 86400000);
  const pos  = ((diff % 8) + 8) % 8;
  return pos < 4;
}

export function countWorkDays(startStr, endStr, dept, rosterStart) {
  if (!startStr || !endStr) return 0;
  const start = new Date(startStr + "T00:00:00");
  const end   = new Date(endStr   + "T00:00:00");
  if (end < start) return 0;
  let cnt = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const ds = cur.toISOString().split("T")[0];
    const isWork = dept === "GD" ? isGDWorkDay(ds) : isShiftWorkDay(ds, rosterStart);
    if (isWork) cnt++;
    cur.setDate(cur.getDate() + 1);
  }
  return cnt;
}

// ── Clash detection (per shift group) ────────────────────────────
export function detectClashes(newStart, newEnd, groupId, requests, excludeId = null) {
  const clashers = [];
  for (const r of requests) {
    if (r.id === excludeId) continue;
    if (["Rejected","Cancelled"].includes(r.status)) continue;
    if (r.groupId !== groupId) continue;
    if (r.endDate < newStart || r.startDate > newEnd) continue;
    clashers.push(r.employeeName);
  }
  return [...new Set(clashers)];
}

// ── Request limit check ──────────────────────────────────────────
export function requestsThisCycle(empId, requests, cycleStart, cycleEndStr) {
  return requests.filter(r =>
    r.employeeId === empId &&
    r.leaveType === "Annual Leave" &&
    r.status !== "Rejected" &&
    r.status !== "Cancelled" &&
    r.startDate >= cycleStart &&
    r.startDate <= cycleEndStr
  ).length;
}

// ── HTML helpers ─────────────────────────────────────────────────
export function statusBadge(status) {
  const map = {
    Pending:             "sb-pending",
    "Approved (Officer)":"sb-officer",
    "Approved (Admin)":  "sb-admin",
    Approved:            "sb-approved",
    Rejected:            "sb-rejected",
    Cancelled:           "sb-cancelled"
  };
  return `<span class="status-badge ${map[status]||"sb-pending"}">${status||"Pending"}</span>`;
}

export function roleBadge(role) {
  const labels = { staff:"Staff", officer:"Officer", fire_admin:"Fire Admin", head_ops:"Head of Ops" };
  return `<span class="role-badge rb-${role}">${labels[role]||role}</span>`;
}

export function pbar(used, total) {
  if (!total) return "--";
  const pct = Math.min(100, Math.round(used / total * 100));
  const cls = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
  return `<div class="pbar-wrap">
    <div class="pbar"><div class="pbar-fill ${cls}" style="width:${pct}%"></div></div>
    <span class="pbar-pct">${pct}%</span>
  </div>`;
}

export function toast(msg, type = "success") {
  const wrap = document.getElementById("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity="0"; el.style.transition="opacity .3s"; setTimeout(()=>el.remove(),300); }, 3800);
}

export function initials(name) {
  if (!name) return "?";
  return name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
}

export function groupType(groupId) {
  return SHIFT_GROUPS.includes(groupId) ? "shift" : "gd";
}
