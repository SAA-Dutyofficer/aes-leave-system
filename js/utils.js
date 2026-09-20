// js/utils.js — AES Fire & Rescue Operations Leave System v2

// ── Groups & Roles ────────────────────────────────────────────────
export const SHIFT_GROUPS = ["White", "Red", "Black", "Green", "Watch Room"];
export const GD_SECTIONS  = ["AES Management", "LFS", "L&D", "Admin", "Logistics", "EP&S"];
export const ALL_GROUPS   = [...SHIFT_GROUPS, ...GD_SECTIONS];

export const ROLES = {
  staff:       "Staff",
  officer:     "Station Officer",
  supervisor:  "Watch Room Supervisor",
  fire_admin:  "Fire Admin",
  section_head:"Section Head",
  director:    "Director (Fire Chief)",
  superadmin:  "Super Admin"
};

export const APPROVER_ROLES = ["officer","supervisor","fire_admin","section_head","director","superadmin"];

// ── Leave types with entitlements ────────────────────────────────
// counting: "workdays" = Mon–Thu, "calendar" = all days
// cycleType: "joining" = resets on joining anniversary, "perEvent" = resets after each use, "oneTime" = never renews
// entitlement: fixed days (null = custom per employee)
export const LEAVE_TYPES = [
  { key:"Annual Leave",            label:"Annual Leave",            entitlement:30,  counting:"workdays",  cycleType:"joining",  color:"blue",   maxRequests:3 },
  { key:"Unpaid Leave",            label:"Unpaid Leave",            entitlement:30,  counting:"workdays",  cycleType:"joining",  color:"slate"  },
  { key:"Sick Leave",              label:"Sick Leave",              entitlement:15,  counting:"workdays",  cycleType:"joining",  color:"amber"  },
  { key:"Paternity Leave",         label:"Paternity Leave",         entitlement:4,   counting:"workdays",  cycleType:"perEvent", color:"navy"   },
  { key:"Hajj Leave",              label:"Hajj Leave",              entitlement:30,  counting:"workdays",  cycleType:"oneTime",  color:"gold"   },
  { key:"Comp Leave",              label:"Comp Leave",              entitlement:null,counting:"calendar",  cycleType:"custom",   color:"purple" },
  { key:"Study Leave",             label:"Study Leave",             entitlement:null,counting:"calendar",  cycleType:"custom",   color:"indigo" },
  { key:"Family Accompanied Leave",label:"Family Accompanied Leave",entitlement:null,counting:"calendar",  cycleType:"custom",   color:"teal"   },
  { key:"Emergency Leave",         label:"Emergency Leave",         entitlement:null,counting:"calendar",  cycleType:"custom",   color:"red"    },
  { key:"National Service",        label:"National Service",        entitlement:null,counting:"calendar",  cycleType:"custom",   color:"green"  },
  { key:"Exam Leave",              label:"Exam Leave",              entitlement:null,counting:"calendar",  cycleType:"custom",   color:"green"  },
];

// Deduplicate
const _seen = new Set();
export const LEAVE_TYPES_UNIQUE = LEAVE_TYPES.filter(t => { if (_seen.has(t.key)) return false; _seen.add(t.key); return true; });

export const LEAVE_TYPE_KEYS = LEAVE_TYPES_UNIQUE.map(t=>t.key);

// Which types follow Mon–Thu counting
export const WORKDAY_TYPES = new Set(LEAVE_TYPES_UNIQUE.filter(t=>t.counting==="workdays").map(t=>t.key));

// ── Leave day counting ────────────────────────────────────────────
export function countLeaveDays(startStr, endStr, leaveType="Annual Leave") {
  if (!startStr || !endStr) return 0;
  const start = new Date(startStr + "T00:00:00");
  const end   = new Date(endStr   + "T00:00:00");
  if (end < start) return 0;

  // Calendar types — count all days inclusive
  if (!WORKDAY_TYPES.has(leaveType)) {
    return Math.round((end - start) / 86400000) + 1;
  }

  // Workday types — Mon–Thu only
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const wd = cur.getDay();
    if (wd >= 1 && wd <= 4) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── Validate leave end date doesn't land on or after cycle end ────
export function validateLeaveDates(startStr, endStr, joinDate) {
  if (!joinDate) return null;
  const { end: cycleEnd } = getCurrentCycle(joinDate);
  if (endStr >= cycleEnd) {
    return `End date must be before ${fmtDate(cycleEnd)} (your cycle ends on ${fmtDate(cycleEnd)} — last valid day is one day before)`;
  }
  return null;
}
// Returns ordered array of role keys needed for full approval
export function getApprovalChain(groupId, submitterRole) {
  const isShift = SHIFT_GROUPS.includes(groupId);
  const isWatchRoom = groupId === "Watch Room";

  // Officers/Supervisors/Section Heads submitting their own leave
  if (["officer","supervisor"].includes(submitterRole)) {
    return ["fire_admin","section_head"];
  }
  if (submitterRole === "section_head") {
    return ["fire_admin","director"];
  }

  // Staff
  if (isWatchRoom) return ["supervisor","fire_admin","section_head"];
  if (isShift)     return ["officer","fire_admin","section_head"];
  return ["fire_admin","section_head"]; // GD sections
}

export function getApprovalChainLabels(chain) {
  return chain.map(r => ROLES[r] || r);
}

// ── Date helpers ──────────────────────────────────────────────────
export function todayStr() {
  return new Date().toISOString().split("T")[0];
}

export function fmtDate(str) {
  if (!str) return "--";
  const d = new Date(str + "T00:00:00");
  if (isNaN(d)) return str;
  return d.toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" });
}

export function fmtDateTime(ts) {
  if (!ts) return "--";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit" });
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

// ── Cycle (joining date anniversary) ─────────────────────────────
export function getCurrentCycle(joinDate) {
  if (!joinDate) return { start: todayStr(), end: todayStr() };
  const today = new Date(todayStr() + "T00:00:00");
  const join  = new Date(joinDate + "T00:00:00");
  let cycleYear = today.getFullYear();

  // Find which anniversary year we're currently in
  let cycleStart = new Date(cycleYear, join.getMonth(), join.getDate());
  if (cycleStart > today) {
    cycleStart = new Date(cycleYear - 1, join.getMonth(), join.getDate());
  }

  // Cycle end = day before next anniversary
  const cycleEnd = new Date(cycleStart);
  cycleEnd.setFullYear(cycleEnd.getFullYear() + 1);
  cycleEnd.setDate(cycleEnd.getDate() - 1);

  return {
    start: cycleStart.toISOString().split("T")[0],
    end:   cycleEnd.toISOString().split("T")[0]
  };
}

export function daysUntilExpiry(joinDate) {
  if (!joinDate) return null;
  const { end } = getCurrentCycle(joinDate);
  const today = new Date(todayStr() + "T00:00:00");
  const endD  = new Date(end + "T00:00:00");
  return Math.ceil((endD - today) / 86400000);
}

// ── Approval chain per group ──────────────────────────────────────
export function getShiftDayType(dateStr, rosterStart) {
  // Returns: 'D' (day), 'N' (night), 'O' (off), or null
  if (!rosterStart) return null;
  const d = new Date(dateStr + "T00:00:00");
  const r = new Date(rosterStart + "T00:00:00");
  const diff = Math.round((d - r) / 86400000);
  const pos  = ((diff % 6) + 6) % 6; // 6-day cycle
  if (pos === 0 || pos === 1) return "D"; // Day shifts
  if (pos === 2 || pos === 3) return "N"; // Night shifts
  return "O"; // Off
}

export function isShiftWorkDay(dateStr, rosterStart) {
  const t = getShiftDayType(dateStr, rosterStart);
  return t === "D" || t === "N";
}

// ── Clash detection ───────────────────────────────────────────────
export function detectClashes(newStart, newEnd, groupId, requests, excludeId = null) {
  return requests.filter(r => {
    if (r.id === excludeId) return false;
    if (["Rejected","Cancelled"].includes(r.status)) return false;
    if (r.groupId !== groupId) return false;
    if (r.endDate < newStart || r.startDate > newEnd) return false;
    return true;
  }).map(r => r.employeeName);
}

// ── Annual leave requests this cycle ─────────────────────────────
export function annualLeaveRequestsThisCycle(empId, requests, joinDate) {
  const { start, end } = getCurrentCycle(joinDate);
  return requests.filter(r =>
    r.employeeId === empId &&
    r.leaveType  === "Annual Leave" &&
    !["Rejected","Cancelled"].includes(r.status) &&
    r.startDate  >= start &&
    r.startDate  <= end
  ).length;
}

// ── HTML helpers ──────────────────────────────────────────────────
export function statusBadge(status) {
  const map = {
    "Pending":               "sb-pending",
    "Approved (Officer)":    "sb-l1",
    "Approved (Supervisor)": "sb-l1",
    "Approved (Admin)":      "sb-l2",
    "Approved (Section Head)":"sb-l3",
    "Approved":              "sb-approved",
    "Rejected":              "sb-rejected",
    "Cancelled":             "sb-cancelled",
    "EditAllowed":           "sb-edit",
  };
  return `<span class="status-badge ${map[status]||"sb-pending"}">${status||"Pending"}</span>`;
}

export function roleBadge(role) {
  return `<span class="role-badge rb-${role}">${ROLES[role]||role}</span>`;
}

export function toast(msg, type = "success") {
  const wrap = document.getElementById("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

export function pbar(used, total) {
  if (!total) return `<span class="pbar-na">--</span>`;
  const pct = Math.min(100, Math.round(used / total * 100));
  const cls = pct >= 100 ? "pbar-danger" : pct >= 80 ? "pbar-warn" : "pbar-ok";
  return `<div class="pbar-wrap">
    <div class="pbar"><div class="pbar-fill ${cls}" style="width:${pct}%"></div></div>
    <span class="pbar-lbl">${used}/${total}</span>
  </div>`;
}
