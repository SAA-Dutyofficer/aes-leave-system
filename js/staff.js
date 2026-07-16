// js/staff.js — AES Leave Management System (v2)
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, addDoc, updateDoc, onSnapshot,
         query, where, orderBy, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fmtDate, todayStr, cycleEnd, countWorkDays,
         detectClashes, requestsThisCycle,
         statusBadge, toast, SHIFT_GROUPS } from "./utils.js";

let ME = null, EMP = null, myRequests = [], allGroupRequests = [];
let calYear, calMonth, calSelStart = null, calSelEnd = null;

// ── Auth ─────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "../index.html"; return; }
  ME = user;
  // Pre-fetch employee while setting up UI
  const [snap] = await Promise.all([
    getDoc(doc(db, "employees", ME.uid))
  ]);
  if (!snap.exists()) { toast("Employee record not found. Contact admin.", "error"); return; }
  EMP = { id: snap.id, ...snap.data() };
  document.getElementById("navName").textContent = EMP.name || ME.email;
  document.getElementById("navDept").textContent = EMP.groupId || EMP.dept || "";
  setupListeners();
  initNav();
  loadRequests();
  loadTeam();
  renderOverview();
});

// ── Data ─────────────────────────────────────────────────────────
function loadRequests() {
  onSnapshot(
    query(collection(db,"leaveRequests"), where("employeeId","==",ME.uid), orderBy("createdAt","desc")),
    snap => {
      myRequests = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      renderOverview();
      renderHistory();
      renderCalendar();
    }
  );
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
  const cs  = EMP.cycleStart || todayStr();
  const ce  = cycleEnd(cs);
  const ent = EMP.entitlement || 0;

  const used = myRequests.filter(r =>
    r.leaveType === "Annual Leave" && r.status === "Approved" &&
    r.startDate >= cs && r.startDate <= ce
  ).reduce((s,r) => s + (r.workDays||0), 0);

  const unpaid = myRequests.filter(r =>
    r.leaveType === "Unpaid Leave" && r.status === "Approved" &&
    r.startDate >= cs && r.startDate <= ce
  ).reduce((s,r) => s + (r.workDays||0), 0);

  const remaining = Math.max(0, ent - used);
  const pct = ent ? Math.min(100, Math.round(used/ent*100)) : 0;

  document.getElementById("bcEntitlement").textContent = ent;
  document.getElementById("bcUsed").textContent        = used;
  document.getElementById("bcRemaining").textContent   = remaining;
  document.getElementById("bcUnpaid").textContent      = unpaid;
  document.getElementById("progressFill").style.width  = pct + "%";
  document.getElementById("progressPct").textContent   = pct + "%";
  document.getElementById("cycleInfo").textContent     = `Cycle: ${fmtDate(cs)} – ${fmtDate(ce)}`;

  // Animate numbers
  document.querySelectorAll(".bc-value").forEach(el => {
    el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
  });

  const today = todayStr();
  const upcoming = myRequests.filter(r => r.endDate >= today && !["Rejected","Cancelled"].includes(r.status)).slice(0,5);
  const upEl = document.getElementById("upcomingLeave");
  upEl.innerHTML = upcoming.length ? upcoming.map(r => `
    <div class="list-item slide-in">
      <div class="li-left">
        <div class="li-title">${r.leaveType}</div>
        <div class="li-sub">${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · ${r.workDays||0} day(s)</div>
      </div>
      <div class="li-right">${statusBadge(r.status)}</div>
    </div>`) .join("") : `<div class="list-empty">No upcoming leave scheduled.</div>`;
}

// ── Interactive 2-month Calendar ──────────────────────────────────
function renderCalendar() {
  const el = document.getElementById("leaveCalendar");
  if (!el || !EMP) return;

  const now = new Date();
  if (!calYear)  calYear  = now.getFullYear();
  if (calMonth === undefined) calMonth = now.getMonth();

  const approvedDates = new Set();
  const pendingDates  = new Set();
  myRequests.forEach(r => {
    if (["Rejected","Cancelled"].includes(r.status)) return;
    let d = new Date(r.startDate + "T00:00:00");
    const end = new Date(r.endDate + "T00:00:00");
    while (d <= end) {
      const ds = d.toISOString().split("T")[0];
      if (r.status === "Approved") approvedDates.add(ds);
      else pendingDates.add(ds);
      d.setDate(d.getDate()+1);
    }
  });

  let html = `<div class="cal-nav">
    <button class="cal-nav-btn" onclick="calPrev()">‹</button>
    <span class="cal-nav-title">${getMonthName(calYear, calMonth)}</span>
    <button class="cal-nav-btn" onclick="calNext()">›</button>
  </div>
  <div class="dual-cal">
    ${buildMonth(calYear, calMonth, approvedDates, pendingDates)}
    ${buildMonth(...nextMonth(calYear, calMonth), approvedDates, pendingDates)}
  </div>
  <div class="cal-legend">
    <span class="leg-item"><span class="leg-dot leg-work"></span>Working</span>
    <span class="leg-item"><span class="leg-dot leg-off"></span>Off day</span>
    <span class="leg-item"><span class="leg-dot leg-selected"></span>Selected</span>
    <span class="leg-item"><span class="leg-dot leg-approved"></span>Approved leave</span>
    <span class="leg-item"><span class="leg-dot leg-pending"></span>Pending</span>
  </div>`;

  el.innerHTML = html;

  if (calSelStart || calSelEnd) {
    const info = document.getElementById("calSelInfo");
    if (calSelStart && calSelEnd) {
      const days = countWorkDays(calSelStart, calSelEnd, EMP.dept, EMP.rosterStart);
      info.textContent = `Selected: ${fmtDate(calSelStart)} → ${fmtDate(calSelEnd)} · ${days} working day(s)`;
      info.style.display = "block";
    } else if (calSelStart) {
      info.textContent = `Start: ${fmtDate(calSelStart)} — now click an end date`;
      info.style.display = "block";
    }
  } else {
    const info = document.getElementById("calSelInfo");
    if (info) info.style.display = "none";
  }
}

function buildMonth(year, month, approvedDates, pendingDates) {
  const first   = new Date(year, month, 1);
  const last    = new Date(year, month+1, 0);
  const mName   = first.toLocaleDateString("en-GB", { month:"long", year:"numeric" });
  const startDay = (first.getDay()+6)%7;
  const today   = todayStr();

  let html = `<div class="cal-month-block">
    <div class="cal-month-title">${mName}</div>
    <div class="cal-grid">`;
  ["M","T","W","T","F","S","S"].forEach(d => html += `<div class="cal-hdr">${d}</div>`);
  for (let i=0; i<startDay; i++) html += `<div class="cal-day empty"></div>`;

  for (let d=1; d<=last.getDate(); d++) {
    const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const isWork = isWorkDay(ds);
    const isPast = ds < today;
    const isApproved = approvedDates.has(ds);
    const isPending  = pendingDates.has(ds);
    const isStart    = ds === calSelStart;
    const isEnd      = ds === calSelEnd;
    const inRange    = calSelStart && calSelEnd && ds > calSelStart && ds < calSelEnd;
    const isToday    = ds === today;

    let cls = "cal-day";
    if (isPast)     cls += " past";
    else if (isApproved) cls += " approved";
    else if (isPending)  cls += " pending";
    else if (isStart || isEnd) cls += " selected";
    else if (inRange)    cls += " in-range";
    else if (isWork)     cls += " work";
    else                 cls += " off";
    if (isToday)    cls += " today";
    if (!isPast && !isApproved && isWork) cls += " clickable";

    html += `<div class="${cls}" onclick="calClick('${ds}')">${d}</div>`;
  }
  html += `</div></div>`;
  return html;
}

function isWorkDay(ds) {
  if (EMP.dept === "GD") {
    const wd = new Date(ds+"T00:00:00").getDay();
    return wd >= 1 && wd <= 4;
  }
  if (!EMP.rosterStart) return false;
  const d = new Date(ds+"T00:00:00");
  const r = new Date(EMP.rosterStart+"T00:00:00");
  const diff = Math.round((d-r)/86400000);
  const pos  = ((diff%8)+8)%8;
  return pos < 4;
}

function getMonthName(y, m) {
  return new Date(y, m, 1).toLocaleDateString("en-GB", { month:"long", year:"numeric" });
}

function nextMonth(y, m) {
  return m === 11 ? [y+1, 0] : [y, m+1];
}

window.calPrev = () => {
  if (calMonth === 0) { calMonth = 11; calYear--; } else calMonth--;
  renderCalendar();
};
window.calNext = () => {
  const [ny, nm] = nextMonth(calYear, calMonth);
  calYear = ny; calMonth = nm;
  renderCalendar();
};

window.calClick = (ds) => {
  const today = todayStr();
  if (ds < today) return;
  if (!calSelStart || (calSelStart && calSelEnd)) {
    calSelStart = ds; calSelEnd = null;
  } else {
    if (ds < calSelStart) { calSelEnd = calSelStart; calSelStart = ds; }
    else if (ds === calSelStart) { calSelStart = null; calSelEnd = null; }
    else calSelEnd = ds;
    if (calSelStart && calSelEnd) {
      document.getElementById("fStartDate").value = calSelStart;
      document.getElementById("fEndDate").value   = calSelEnd;
      updatePreview();
    }
  }
  renderCalendar();
};

// ── History ──────────────────────────────────────────────────────
function renderHistory() {
  const filter = document.getElementById("historyFilter").value;
  let list = [...myRequests];
  if (filter !== "all") list = list.filter(r => r.status === filter);
  const el = document.getElementById("historyList");
  if (!list.length) { el.innerHTML = `<div class="list-empty">No requests found.</div>`; return; }
  el.innerHTML = list.map(r => `
    <div class="request-card slide-in">
      <div class="rc-head">
        <span class="rc-type">${r.leaveType}</span>
        ${statusBadge(r.status)}
      </div>
      <div class="rc-dates">📅 ${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · <strong>${r.workDays||0} day(s)</strong></div>
      ${r.notes ? `<div class="rc-notes">📝 ${r.notes}</div>` : ""}
      <div class="rc-approval-trail">${renderTrail(r)}</div>
      ${r.rejectionReason ? `<div class="rc-notes" style="color:#991b1b">❌ Reason: ${r.rejectionReason}</div>` : ""}
      <div class="rc-actions">
        ${r.status === "Pending" ? `
          <button class="btn btn-ghost btn-sm" onclick="openEditModal('${r.id}')">✏️ Edit</button>
          <button class="btn btn-ghost btn-sm" style="color:#991b1b" onclick="cancelRequest('${r.id}')">Cancel</button>` : ""}
        ${(r.status === "Approved" || r.status === "Approved (Officer)" || r.status === "Approved (Admin)" || r.status === "Approved (Head Ops)") && !r.editRequested ? `
          <button class="btn btn-ghost btn-sm" onclick="requestEdit('${r.id}')">✏️ Request Edit</button>` : ""}
        ${r.editRequested && r.status !== "EditAllowed" ? `
          <span style="font-size:12px;color:#c27803">⏳ Edit request pending approval</span>` : ""}
        ${r.status === "EditAllowed" ? `
          <button class="btn btn-ghost btn-sm" onclick="openEditModal('${r.id}')">✏️ Edit Now</button>` : ""}
      </div>
    </div>`).join("");
}

// ── Edit modal ────────────────────────────────────────────────────
window.openEditModal = (reqId) => {
  const r = myRequests.find(x => x.id === reqId);
  if (!r) return;
  document.getElementById("editRequestId").value  = reqId;
  document.getElementById("editStart").value      = r.startDate;
  document.getElementById("editEnd").value        = r.endDate;
  document.getElementById("editNotes").value      = r.notes || "";
  document.getElementById("editLeaveType").value  = r.leaveType;
  document.getElementById("editError").textContent = "";
  document.getElementById("editModal").style.display = "flex";
};

document.getElementById("editModalClose").addEventListener("click",  () => document.getElementById("editModal").style.display = "none");
document.getElementById("editModalCancel").addEventListener("click", () => document.getElementById("editModal").style.display = "none");

document.getElementById("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl    = document.getElementById("editError");
  const reqId    = document.getElementById("editRequestId").value;
  const start    = document.getElementById("editStart").value;
  const end      = document.getElementById("editEnd").value;
  const notes    = document.getElementById("editNotes").value.trim();
  const leaveType= document.getElementById("editLeaveType").value;
  errEl.textContent = "";
  if (!start || !end || end < start) { errEl.textContent = "Invalid dates."; return; }
  const days = countWorkDays(start, end, EMP.dept, EMP.rosterStart);
  if (days === 0) { errEl.textContent = "No working days in selected range."; return; }
  try {
    await updateDoc(doc(db,"leaveRequests",reqId), {
      startDate: start, endDate: end, workDays: days,
      notes, leaveType,
      status: "Pending",
      editRequested: false,
      officerStatus: null, officerName: null, officerAt: null,
      adminStatus:   null, adminName:   null, adminAt:   null,
      headOpsStatus: null, headOpsName: null, headOpsAt: null,
    });
    toast("✅ Request updated!");
    document.getElementById("editModal").style.display = "none";
  } catch(err) { errEl.textContent = "Failed to update: " + err.message; }
});

window.requestEdit = async (reqId) => {
  if (!confirm("Request approval to edit this leave?")) return;
  try {
    await updateDoc(doc(db,"leaveRequests",reqId), { editRequested: true });
    toast("Edit request sent — waiting for approval.");
  } catch(err) { toast("Error: " + err.message, "error"); }
};

function renderTrail(r) {
  const steps = [
    { label:"Officer",    status:r.officerStatus, by:r.officerName },
    { label:"Fire Admin", status:r.adminStatus,   by:r.adminName },
    { label:"Head of Ops",status:r.headOpsStatus, by:r.headOpsName },
  ];
  return `<div class="approval-trail">${steps.map(s => `
    <div class="at-step ${s.status||"pending"}">
      <span class="at-dot">${s.status==="approved"?"✅":s.status==="rejected"?"❌":"⏳"}</span>
      <span class="at-label">${s.label}</span>
      ${s.by?`<span class="at-by">${s.by}</span>`:""}
    </div>`).join("")}</div>`;
}

// ── Team ─────────────────────────────────────────────────────────
function renderTeam(members) {
  const el = document.getElementById("teamList");
  document.getElementById("teamGroupLabel").textContent = `${EMP.groupId||"My Team"} — ${members.length+1} members`;
  const today = todayStr();
  el.innerHTML = members.map(m => {
    const onLeave = allGroupRequests.find(r =>
      r.employeeId===m.id && r.status==="Approved" && r.startDate<=today && r.endDate>=today
    );
    return `<div class="list-item slide-in">
      <div class="li-avatar">${(m.name||"?")[0].toUpperCase()}</div>
      <div class="li-left">
        <div class="li-title">${m.name}</div>
        <div class="li-sub">${m.groupId||""} · ${m.dept||""}</div>
      </div>
      <div class="li-right">
        ${onLeave ? `<span class="badge-leave">On Leave</span>` : `<span class="badge-avail">Available</span>`}
      </div>
    </div>`;
  }).join("") || `<div class="list-empty">No other members in your group.</div>`;
}

// ── Leave form ────────────────────────────────────────────────────
function setupListeners() {
  document.getElementById("fStartDate").addEventListener("change", updatePreview);
  document.getElementById("fEndDate").addEventListener("change",   updatePreview);
  document.getElementById("fLeaveType").addEventListener("change", updatePreview);
  document.getElementById("historyFilter").addEventListener("change", renderHistory);
  document.getElementById("logoutBtn").addEventListener("click", () =>
    signOut(auth).then(() => window.location.href = "../index.html")
  );
  document.getElementById("leaveForm").addEventListener("submit", submitRequest);

  // Sync manual date inputs back to calendar selection
  document.getElementById("fStartDate").addEventListener("change", e => {
    calSelStart = e.target.value; renderCalendar();
  });
  document.getElementById("fEndDate").addEventListener("change", e => {
    calSelEnd = e.target.value; renderCalendar();
  });
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

  const clashers = detectClashes(start, end, EMP.groupId, allGroupRequests);
  if (clashers.length) {
    clashEl.style.display = "block";
    document.getElementById("clashMsg").textContent = `${clashers.length} teammate(s) already on leave: ${clashers.join(", ")}`;
  } else { clashEl.style.display = "none"; }

  if (type === "Annual Leave") {
    const cs = EMP.cycleStart || todayStr();
    const ce = cycleEnd(cs);
    const used = myRequests.filter(r =>
      r.leaveType==="Annual Leave" && r.status==="Approved" && r.startDate>=cs && r.startDate<=ce
    ).reduce((s,r)=>s+(r.workDays||0),0);
    const remaining = (EMP.entitlement||0) - used;
    const maxReq = EMP.dept==="GD" ? 4 : 3;
    const reqCount = requestsThisCycle(ME.uid, myRequests, cs, ce);
    if (reqCount >= maxReq) {
      balanceEl.style.display="block";
      balanceEl.textContent=`⚠️ Maximum ${maxReq} Annual Leave requests allowed this cycle.`;
    } else if (days > remaining) {
      balanceEl.style.display="block";
      balanceEl.textContent=`⚠️ Only ${remaining} days remaining but ${days} selected.`;
    } else { balanceEl.style.display="none"; }
  } else { balanceEl.style.display="none"; }
}

async function submitRequest(e) {
  e.preventDefault();
  const errEl = document.getElementById("formError");
  const btn   = document.getElementById("submitBtn");
  errEl.textContent = "";
  btn.disabled = true; btn.textContent = "Submitting…";

  const start = document.getElementById("fStartDate").value;
  const end   = document.getElementById("fEndDate").value;
  const type  = document.getElementById("fLeaveType").value;
  const notes = document.getElementById("fNotes").value.trim();

  if (!start || !end || end < start) { errEl.textContent="Invalid dates."; btn.disabled=false; btn.textContent="Submit Request"; return; }
  const days = countWorkDays(start, end, EMP.dept, EMP.rosterStart);
  if (days===0) { errEl.textContent="No working days in selected range."; btn.disabled=false; btn.textContent="Submit Request"; return; }

  if (type==="Annual Leave") {
    const cs=EMP.cycleStart||todayStr(), ce=cycleEnd(cs);
    const maxReq=EMP.dept==="GD"?4:3;
    if (requestsThisCycle(ME.uid, myRequests, cs, ce) >= maxReq) {
      errEl.textContent=`Maximum ${maxReq} Annual Leave requests per cycle.`;
      btn.disabled=false; btn.textContent="Submit Request"; return;
    }
  }

  try {
    await addDoc(collection(db,"leaveRequests"), {
      employeeId:ME.uid, employeeName:EMP.name, groupId:EMP.groupId||null,
      dept:EMP.dept, leaveType:type, startDate:start, endDate:end, workDays:days, notes,
      status:"Pending",
      officerStatus:null, officerName:null, officerAt:null,
      adminStatus:null,   adminName:null,   adminAt:null,
      headOpsStatus:null, headOpsName:null, headOpsAt:null,
      createdAt:serverTimestamp()
    });
    toast("✅ Leave request submitted!");
    document.getElementById("leaveForm").reset();
    calSelStart=null; calSelEnd=null;
    document.getElementById("daysPreview").style.display="none";
    document.getElementById("clashWarning").style.display="none";
    document.getElementById("balanceWarning").style.display="none";
    renderCalendar();
    showSection("history");
  } catch(err) { errEl.textContent="Failed: "+err.message; }
  finally { btn.disabled=false; btn.textContent="Submit Request"; }
}

window.cancelRequest = async (reqId) => {
  if (!confirm("Cancel this leave request?")) return;
  try { await updateDoc(doc(db,"leaveRequests",reqId), { status:"Cancelled" }); toast("Request cancelled."); }
  catch(err) { toast("Error: "+err.message,"error"); }
};

// ── Navigation ────────────────────────────────────────────────────
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
  if (id==="request") { renderCalendar(); }
}
window.showSection = showSection;
