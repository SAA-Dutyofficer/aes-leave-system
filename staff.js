// js/staff.js — AES Leave Management System
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, getDocs, addDoc, updateDoc, onSnapshot,
         query, where, orderBy, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fmtDate, fmtDateTime, todayStr, addDays, cycleEnd,
         countWorkDays, detectClashes, requestsThisCycle,
         statusBadge, toast, LEAVE_TYPES, SHIFT_GROUPS, groupType } from "./utils.js";

let ME = null, EMP = null, myRequests = [], allGroupRequests = [];

// ── Auth guard ───────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "../index.html"; return; }
  ME = user;
  await loadEmployee();
  setupListeners();
  initNav();
});

async function loadEmployee() {
  const snap = await getDoc(doc(db, "employees", ME.uid));
  if (!snap.exists()) { toast("Employee record not found. Contact admin.", "error"); return; }
  EMP = { id: snap.id, ...snap.data() };
  document.getElementById("navName").textContent = EMP.name || ME.email;
  renderOverview();
  loadRequests();
  loadTeam();
  renderMiniCalendar();
}

// ── Firestore listeners ──────────────────────────────────────────
function loadRequests() {
  // My requests
  onSnapshot(
    query(collection(db,"leaveRequests"), where("employeeId","==",ME.uid), orderBy("createdAt","desc")),
    snap => {
      myRequests = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      renderOverview();
      renderHistory();
      renderMiniCalendar();
    }
  );

  // Group requests for clash detection
  if (EMP.groupId) {
    onSnapshot(
      query(collection(db,"leaveRequests"), where("groupId","==",EMP.groupId)),
      snap => { allGroupRequests = snap.docs.map(d => ({ id:d.id, ...d.data() })); }
    );
  }
}

function loadTeam() {
  if (!EMP.groupId) return;
  onSnapshot(
    query(collection(db,"employees"), where("groupId","==",EMP.groupId)),
    snap => {
      const members = snap.docs.map(d => ({ id:d.id, ...d.data() })).filter(e => e.id !== ME.uid);
      renderTeam(members);
    }
  );
}

// ── Overview ─────────────────────────────────────────────────────
function renderOverview() {
  if (!EMP) return;
  const cycleStart = EMP.cycleStart || todayStr();
  const cycleEndStr = cycleEnd(cycleStart);
  const entitlement = EMP.entitlement || 0;

  const approved = myRequests.filter(r =>
    r.leaveType === "Annual Leave" &&
    r.status === "Approved" &&
    r.startDate >= cycleStart && r.startDate <= cycleEndStr
  );
  const used = approved.reduce((s, r) => s + (r.workDays || 0), 0);
  const unpaid = myRequests.filter(r =>
    r.leaveType === "Unpaid Leave" && r.status === "Approved" &&
    r.startDate >= cycleStart && r.startDate <= cycleEndStr
  ).reduce((s,r) => s + (r.workDays||0), 0);

  document.getElementById("bcEntitlement").textContent = entitlement;
  document.getElementById("bcUsed").textContent        = used;
  document.getElementById("bcRemaining").textContent   = Math.max(0, entitlement - used);
  document.getElementById("bcUnpaid").textContent      = unpaid;

  const pct = entitlement ? Math.min(100, Math.round(used/entitlement*100)) : 0;
  document.getElementById("progressFill").style.width = pct + "%";
  document.getElementById("progressPct").textContent  = pct + "%";
  document.getElementById("cycleInfo").textContent    = `Cycle: ${fmtDate(cycleStart)} – ${fmtDate(cycleEndStr)}`;

  // Upcoming
  const today = todayStr();
  const upcoming = myRequests
    .filter(r => r.endDate >= today && !["Rejected","Cancelled"].includes(r.status))
    .slice(0, 5);
  const upEl = document.getElementById("upcomingLeave");
  if (!upcoming.length) {
    upEl.innerHTML = `<div class="list-empty">No upcoming leave scheduled.</div>`;
  } else {
    upEl.innerHTML = upcoming.map(r => `
      <div class="list-item">
        <div class="li-left">
          <div class="li-title">${r.leaveType}</div>
          <div class="li-sub">${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · ${r.workDays||0} day(s)</div>
        </div>
        <div class="li-right">${statusBadge(r.status)}</div>
      </div>`).join("");
  }
}

// ── History ──────────────────────────────────────────────────────
function renderHistory() {
  const filter = document.getElementById("historyFilter").value;
  let list = [...myRequests];
  if (filter !== "all") list = list.filter(r => r.status === filter);

  const el = document.getElementById("historyList");
  if (!list.length) { el.innerHTML = `<div class="list-empty">No requests found.</div>`; return; }

  el.innerHTML = list.map(r => `
    <div class="request-card">
      <div class="rc-head">
        <span class="rc-type">${r.leaveType}</span>
        ${statusBadge(r.status)}
      </div>
      <div class="rc-dates">${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · <strong>${r.workDays||0} day(s)</strong></div>
      ${r.notes ? `<div class="rc-notes">📝 ${r.notes}</div>` : ""}
      <div class="rc-approval-trail">${renderApprovalTrail(r)}</div>
      ${r.status === "Pending" ? `
        <div class="rc-actions">
          <button class="btn btn-ghost btn-sm" onclick="cancelRequest('${r.id}')">Cancel Request</button>
        </div>` : ""}
    </div>`).join("");
}

function renderApprovalTrail(r) {
  const steps = [
    { label: "Officer",    status: r.officerStatus,    by: r.officerName,    at: r.officerAt },
    { label: "Fire Admin", status: r.adminStatus,      by: r.adminName,      at: r.adminAt },
    { label: "Head of Ops",status: r.headOpsStatus,    by: r.headOpsName,    at: r.headOpsAt },
  ];
  return `<div class="approval-trail">${steps.map(s => `
    <div class="at-step ${s.status||"pending"}">
      <span class="at-label">${s.label}</span>
      <span class="at-status">${s.status ? (s.status==="approved"?"✅":"❌") : "⏳"}</span>
      ${s.by ? `<span class="at-by">${s.by}</span>` : ""}
    </div>`).join("")}
  </div>`;
}

// ── Team ─────────────────────────────────────────────────────────
function renderTeam(members) {
  const el = document.getElementById("teamList");
  document.getElementById("teamGroupLabel").textContent = `${EMP.groupId || "My Team"} Members`;
  if (!members.length) { el.innerHTML = `<div class="list-empty">No other members in your group.</div>`; return; }

  const today = todayStr();
  el.innerHTML = members.map(m => {
    const onLeave = allGroupRequests.find(r =>
      r.employeeId === m.id && r.status === "Approved" &&
      r.startDate <= today && r.endDate >= today
    );
    return `<div class="list-item">
      <div class="li-avatar">${(m.name||"?")[0]}</div>
      <div class="li-left">
        <div class="li-title">${m.name}</div>
        <div class="li-sub">${m.groupId || ""} · ${m.dept || ""}</div>
      </div>
      <div class="li-right">
        ${onLeave ? `<span class="on-leave-dot">On Leave</span>` : `<span class="available-dot">Available</span>`}
      </div>
    </div>`;
  }).join("");
}

// ── Mini calendar ────────────────────────────────────────────────
function renderMiniCalendar() {
  const el = document.getElementById("miniCalendar");
  if (!el || !EMP) return;
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth();
  const first = new Date(year, month, 1);
  const last  = new Date(year, month+1, 0);
  const monthName = first.toLocaleDateString("en-GB", { month:"long", year:"numeric" });

  const approvedDates = new Set();
  myRequests.filter(r => r.status==="Approved").forEach(r => {
    let d = new Date(r.startDate+"T00:00:00");
    const end = new Date(r.endDate+"T00:00:00");
    while (d <= end) { approvedDates.add(d.toISOString().split("T")[0]); d.setDate(d.getDate()+1); }
  });

  let html = `<div class="cal-month">${monthName}</div><div class="cal-grid">`;
  ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].forEach(d => html += `<div class="cal-hdr">${d}</div>`);

  const startDay = (first.getDay()+6)%7;
  for (let i=0; i<startDay; i++) html += `<div class="cal-day empty"></div>`;

  for (let d=1; d<=last.getDate(); d++) {
    const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const isWork = EMP.dept==="GD"
      ? [1,2,3,4].includes(new Date(ds+"T00:00:00").getDay())
      : isShiftWorkDayLocal(ds);
    const isTaken = approvedDates.has(ds);
    const cls = isTaken ? "cal-day taken" : isWork ? "cal-day work" : "cal-day off";
    html += `<div class="${cls}">${d}</div>`;
  }
  html += `</div>`;
  el.innerHTML = html;
}

function isShiftWorkDayLocal(ds) {
  if (!EMP.rosterStart) return false;
  const d = new Date(ds+"T00:00:00");
  const r = new Date(EMP.rosterStart+"T00:00:00");
  const diff = Math.round((d-r)/86400000);
  const pos  = ((diff%8)+8)%8;
  return pos < 4;
}

// ── Leave form ───────────────────────────────────────────────────
function setupListeners() {
  document.getElementById("fStartDate").addEventListener("change", updatePreview);
  document.getElementById("fEndDate").addEventListener("change", updatePreview);
  document.getElementById("fLeaveType").addEventListener("change", updatePreview);
  document.getElementById("historyFilter").addEventListener("change", renderHistory);
  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth).then(() => window.location.href="../index.html"));

  document.getElementById("leaveForm").addEventListener("submit", submitRequest);
}

function updatePreview() {
  const start = document.getElementById("fStartDate").value;
  const end   = document.getElementById("fEndDate").value;
  const type  = document.getElementById("fLeaveType").value;
  const previewEl = document.getElementById("daysPreview");
  const clashEl   = document.getElementById("clashWarning");
  const balanceEl = document.getElementById("balanceWarning");

  if (!start || !end || end < start) { previewEl.style.display="none"; return; }

  const days = countWorkDays(start, end, EMP.dept, EMP.rosterStart);
  document.getElementById("daysCount").textContent = days;
  previewEl.style.display = "block";

  // Clash check
  const clashers = detectClashes(start, end, EMP.groupId, allGroupRequests);
  if (clashers.length) {
    clashEl.style.display = "block";
    document.getElementById("clashMsg").textContent = `${clashers.length} teammate(s) already on leave: ${clashers.join(", ")}`;
  } else {
    clashEl.style.display = "none";
  }

  // Balance check for annual leave
  if (type === "Annual Leave") {
    const cycleStart  = EMP.cycleStart || todayStr();
    const cycleEndStr = cycleEnd(cycleStart);
    const used = myRequests.filter(r =>
      r.leaveType==="Annual Leave" && r.status==="Approved" &&
      r.startDate>=cycleStart && r.startDate<=cycleEndStr
    ).reduce((s,r)=>s+(r.workDays||0),0);
    const remaining = (EMP.entitlement||0) - used;

    // Request limit check
    const maxRequests = EMP.dept==="GD" ? 4 : 3;
    const reqCount = requestsThisCycle(ME.uid, myRequests, cycleStart, cycleEndStr);
    if (reqCount >= maxRequests) {
      balanceEl.style.display = "block";
      balanceEl.textContent = `⚠️ You have reached your maximum of ${maxRequests} Annual Leave requests this cycle.`;
    } else if (days > remaining) {
      balanceEl.style.display = "block";
      balanceEl.textContent = `⚠️ This request uses ${days} days but you only have ${remaining} days remaining.`;
    } else {
      balanceEl.style.display = "none";
    }
  } else {
    balanceEl.style.display = "none";
  }
}

async function submitRequest(e) {
  e.preventDefault();
  const errEl = document.getElementById("formError");
  errEl.textContent = "";

  const start  = document.getElementById("fStartDate").value;
  const end    = document.getElementById("fEndDate").value;
  const type   = document.getElementById("fLeaveType").value;
  const notes  = document.getElementById("fNotes").value.trim();

  if (!start || !end || end < start) { errEl.textContent = "Invalid dates."; return; }

  const days = countWorkDays(start, end, EMP.dept, EMP.rosterStart);
  if (days === 0) { errEl.textContent = "No working days in selected range."; return; }

  // Max requests check
  if (type === "Annual Leave") {
    const cycleStart  = EMP.cycleStart || todayStr();
    const cycleEndStr = cycleEnd(cycleStart);
    const maxRequests = EMP.dept==="GD" ? 4 : 3;
    const reqCount = requestsThisCycle(ME.uid, myRequests, cycleStart, cycleEndStr);
    if (reqCount >= maxRequests) {
      errEl.textContent = `Maximum ${maxRequests} Annual Leave requests allowed per cycle.`;
      return;
    }
  }

  try {
    await addDoc(collection(db,"leaveRequests"), {
      employeeId:   ME.uid,
      employeeName: EMP.name,
      groupId:      EMP.groupId || null,
      dept:         EMP.dept,
      leaveType:    type,
      startDate:    start,
      endDate:      end,
      workDays:     days,
      notes,
      status:       "Pending",
      officerStatus: null, officerName: null, officerAt: null,
      adminStatus:   null, adminName:   null, adminAt:   null,
      headOpsStatus: null, headOpsName: null, headOpsAt: null,
      createdAt:    serverTimestamp()
    });
    toast("✅ Leave request submitted!");
    document.getElementById("leaveForm").reset();
    document.getElementById("daysPreview").style.display   = "none";
    document.getElementById("clashWarning").style.display  = "none";
    document.getElementById("balanceWarning").style.display= "none";
    showSection("history");
  } catch(err) {
    errEl.textContent = "Failed to submit: " + err.message;
  }
}

window.cancelRequest = async (reqId) => {
  if (!confirm("Cancel this leave request?")) return;
  try {
    await updateDoc(doc(db,"leaveRequests",reqId), { status:"Cancelled" });
    toast("Request cancelled.");
  } catch(err) { toast("Error: "+err.message,"error"); }
};

// ── Navigation ───────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll(".bnav-item").forEach(btn => {
    btn.addEventListener("click", () => showSection(btn.dataset.section));
  });
}

function showSection(id) {
  document.querySelectorAll(".page-section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".bnav-item").forEach(b => b.classList.remove("active"));
  document.getElementById("section-"+id)?.classList.add("active");
  document.querySelector(`.bnav-item[data-section="${id}"]`)?.classList.add("active");
  if (id==="request") renderMiniCalendar();
}

window.showSection = showSection;
