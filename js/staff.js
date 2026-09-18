// js/staff.js — AES Leave Management System v2
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut, EmailAuthProvider,
         reauthenticateWithCredential, updatePassword }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, addDoc, updateDoc, onSnapshot,
         query, where, orderBy, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fmtDate, todayStr, getCurrentCycle, daysUntilExpiry, countLeaveDays,
         detectClashes, getShiftDayType, isShiftWorkDay, LEAVE_TYPES,
         SHIFT_GROUPS, getApprovalChain, statusBadge, toast, annualLeaveRequestsThisCycle } from "./utils.js";
import { sendEmail } from "./email.js";

let ME = null, EMP = null, myRequests = [], groupRequests = [];
let calYear, calMonth, calSelStart = null, calSelEnd = null;

// ── Auth ──────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "../index.html"; return; }
  ME = user;
  const snap = await getDoc(doc(db, "employees", ME.uid));
  if (!snap.exists()) { toast("Employee record not found. Contact admin.", "error"); return; }
  EMP = { id: snap.id, ...snap.data() };

  document.getElementById("navName").textContent  = EMP.name || ME.email;
  document.getElementById("navRole").textContent  = EMP.groupId || "";
  document.getElementById("navInitials").textContent = initials(EMP.name);

  setupListeners();
  initNav();
  loadData();
  checkEntitlementExpiry();
});

function initials(name) {
  if (!name) return "?";
  return name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
}

// ── Data ──────────────────────────────────────────────────────────
function loadData() {
  onSnapshot(
    query(collection(db,"leaveRequests"), where("employeeId","==",ME.uid), orderBy("createdAt","desc")),
    snap => {
      myRequests = snap.docs.map(d=>({id:d.id,...d.data()}));
      renderOverview();
      renderHistory();
      renderCalendar();
    }
  );
  if (EMP.groupId) {
    onSnapshot(
      query(collection(db,"leaveRequests"), where("groupId","==",EMP.groupId)),
      snap => { groupRequests = snap.docs.map(d=>({id:d.id,...d.data()})); }
    );
  }
}

// ── Entitlement expiry check ──────────────────────────────────────
function checkEntitlementExpiry() {
  if (!EMP.joinDate) return;
  const days = daysUntilExpiry(EMP.joinDate);
  if (days !== null && days <= 30 && days >= 0) {
    showBanner(`⚠️ Your leave entitlement expires in ${days} day(s). Use remaining leave or it will be renewed on your joining date anniversary.`, "warn");
  }
}

function showBanner(msg, type = "info") {
  const b = document.getElementById("topBanner");
  b.textContent = msg;
  b.className = `top-banner banner-${type}`;
  b.style.display = "block";
}

// ── Overview ──────────────────────────────────────────────────────
function renderOverview() {
  if (!EMP) return;
  const { start, end } = getCurrentCycle(EMP.joinDate);
  const ent = EMP.entitlement || 0;

  const approvedDays = myRequests
    .filter(r => r.leaveType==="Annual Leave" && r.status==="Approved" && r.startDate>=start && r.startDate<=end)
    .reduce((s,r) => s+(r.workDays||0), 0);

  const pendingDays = myRequests
    .filter(r => r.leaveType==="Annual Leave" && !["Approved","Rejected","Cancelled"].includes(r.status) && r.startDate>=start && r.startDate<=end)
    .reduce((s,r) => s+(r.workDays||0), 0);

  const unpaidDays = myRequests
    .filter(r => r.leaveType==="Unpaid Leave" && r.status==="Approved" && r.startDate>=start && r.startDate<=end)
    .reduce((s,r) => s+(r.workDays||0), 0);

  const remaining = Math.max(0, ent - approvedDays);
  const pct = ent ? Math.min(100, Math.round(approvedDays/ent*100)) : 0;
  const daysLeft = daysUntilExpiry(EMP.joinDate);

  document.getElementById("ovEntitlement").textContent = ent;
  document.getElementById("ovUsed").textContent        = approvedDays;
  document.getElementById("ovPending").textContent     = pendingDays;
  document.getElementById("ovRemaining").textContent   = remaining;
  document.getElementById("ovUnpaid").textContent      = unpaidDays;
  document.getElementById("ovCycle").textContent       = `${fmtDate(start)} — ${fmtDate(end)}`;
  document.getElementById("ovExpiry").textContent      = daysLeft !== null ? `${daysLeft} days until renewal` : "--";
  document.getElementById("ovBar").style.width         = pct + "%";
  document.getElementById("ovBarPct").textContent      = pct + "%";
  document.getElementById("ovBar").className           = `ov-bar-fill ${pct>=100?"bar-danger":pct>=80?"bar-warn":"bar-ok"}`;

  // Upcoming
  const today = todayStr();
  const upcoming = myRequests.filter(r => r.endDate>=today && !["Rejected","Cancelled"].includes(r.status)).slice(0,5);
  const upEl = document.getElementById("upcomingList");
  upEl.innerHTML = upcoming.length ? upcoming.map(r=>`
    <div class="list-row">
      <div class="lr-info">
        <div class="lr-title">${r.leaveType}</div>
        <div class="lr-sub">${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · ${r.workDays||0} day(s)</div>
      </div>
      <div>${statusBadge(r.status)}</div>
    </div>`).join("") : `<div class="empty-state">No upcoming leave scheduled.</div>`;
}

// ── Interactive Calendar ──────────────────────────────────────────
function renderCalendar() {
  const el = document.getElementById("leaveCalendar");
  if (!el || !EMP) return;
  const now = new Date();
  if (!calYear)              calYear  = now.getFullYear();
  if (calMonth === undefined) calMonth = now.getMonth();

  const approvedDates = new Set();
  const pendingDates  = new Set();
  myRequests.forEach(r => {
    if (["Rejected","Cancelled"].includes(r.status)) return;
    let d = new Date(r.startDate+"T00:00:00");
    const end = new Date(r.endDate+"T00:00:00");
    while (d<=end) {
      const ds = d.toISOString().split("T")[0];
      r.status==="Approved" ? approvedDates.add(ds) : pendingDates.add(ds);
      d.setDate(d.getDate()+1);
    }
  });

  const isShift = SHIFT_GROUPS.includes(EMP.groupId);

  let html = `<div class="cal-header">
    <button class="cal-nav" onclick="calPrev()">&#8249;</button>
    <span class="cal-title">${getMonthLabel(calYear,calMonth)}</span>
    <button class="cal-nav" onclick="calNext()">&#8250;</button>
  </div>
  <div class="dual-cal">
    ${buildMonth(calYear,calMonth,approvedDates,pendingDates,isShift)}
    ${buildMonth(...nextMon(calYear,calMonth),approvedDates,pendingDates,isShift)}
  </div>`;

  if (calSelStart) {
    const selEnd = calSelEnd || calSelStart;
    const days = countLeaveDays(calSelStart, selEnd);
    html += `<div class="cal-sel-info">
      ${calSelStart === calSelEnd || !calSelEnd
        ? `Start: <strong>${fmtDate(calSelStart)}</strong> — click end date`
        : `<strong>${fmtDate(calSelStart)}</strong> → <strong>${fmtDate(selEnd)}</strong> · <strong>${days} working day(s)</strong>`}
    </div>`;
  }

  html += `<div class="cal-legend">
    <span class="leg"><span class="leg-dot ld-work"></span>Mon–Thu (countable)</span>
    <span class="leg"><span class="leg-dot ld-weekend"></span>Fri–Sun</span>
    ${isShift?`<span class="leg"><span class="leg-dot ld-day"></span>Day shift</span>
    <span class="leg"><span class="leg-dot ld-night"></span>Night shift</span>
    <span class="leg"><span class="leg-dot ld-off"></span>Off day</span>`:""}
    <span class="leg"><span class="leg-dot ld-sel"></span>Selected</span>
    <span class="leg"><span class="leg-dot ld-approved"></span>On leave</span>
    <span class="leg"><span class="leg-dot ld-pending"></span>Pending</span>
  </div>`;

  el.innerHTML = html;
}

function buildMonth(year, month, approvedDates, pendingDates, isShift) {
  const first    = new Date(year, month, 1);
  const last     = new Date(year, month+1, 0);
  const startDay = (first.getDay()+6)%7;
  const today    = todayStr();
  const mLabel   = first.toLocaleDateString("en-GB", {month:"long",year:"numeric"});

  let html = `<div class="cal-month-block">
    <div class="cal-month-label">${mLabel}</div>
    <div class="cal-grid7">`;
  ["M","T","W","T","F","S","S"].forEach(d => html+=`<div class="cal-hdr">${d}</div>`);
  for (let i=0;i<startDay;i++) html+=`<div class="cal-cell empty"></div>`;

  for (let d=1;d<=last.getDate();d++) {
    const ds  = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const wd  = new Date(ds+"T00:00:00").getDay(); // 0=Sun
    const isWorkDay = wd>=1 && wd<=4; // Mon–Thu
    const isPast    = ds < today;
    const isApproved= approvedDates.has(ds);
    const isPending = pendingDates.has(ds);
    const isStart   = ds === calSelStart;
    const isEnd     = ds === calSelEnd;
    const inRange   = calSelStart && calSelEnd && ds>calSelStart && ds<calSelEnd;
    const isToday   = ds === today;
    const shiftType = isShift ? getShiftDayType(ds, EMP.rosterStart) : null;

    let cls = "cal-cell";
    if (isPast)      cls += " cal-past";
    else if (isApproved) cls += " cal-approved";
    else if (isPending)  cls += " cal-pending";
    else if (isStart||isEnd) cls += " cal-sel";
    else if (inRange)    cls += " cal-range";
    else if (isShift && shiftType==="D") cls += " cal-day-shift";
    else if (isShift && shiftType==="N") cls += " cal-night-shift";
    else if (isShift && shiftType==="O") cls += " cal-shift-off";
    else if (isWorkDay)  cls += " cal-work";
    else                 cls += " cal-weekend";
    if (isToday)     cls += " cal-today";
    if (!isPast && !isApproved && isWorkDay) cls += " cal-clickable";

    html += `<div class="${cls}" onclick="calClick('${ds}')" title="${ds}">${d}</div>`;
  }
  html += `</div></div>`;
  return html;
}

function getMonthLabel(y,m) { return new Date(y,m,1).toLocaleDateString("en-GB",{month:"long",year:"numeric"}); }
function nextMon(y,m) { return m===11?[y+1,0]:[y,m+1]; }

window.calPrev = () => { if(calMonth===0){calMonth=11;calYear--;}else calMonth--; renderCalendar(); };
window.calNext = () => { const [y,m]=nextMon(calYear,calMonth); calYear=y; calMonth=m; renderCalendar(); };

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

// ── Leave form ────────────────────────────────────────────────────
function updatePreview() {
  const start = document.getElementById("fStartDate").value;
  const end   = document.getElementById("fEndDate").value;
  const type  = document.getElementById("fLeaveType").value;
  const preEl = document.getElementById("daysPreview");
  const warnEl= document.getElementById("leaveWarning");

  warnEl.style.display = "none";
  if (!start||!end||end<start) { preEl.style.display="none"; return; }

  const days = countLeaveDays(start, end);
  document.getElementById("daysCount").textContent = days;
  preEl.style.display = "flex";

  if (type==="Annual Leave" && EMP.joinDate) {
    const { start:cs, end:ce } = getCurrentCycle(EMP.joinDate);
    const ent = EMP.entitlement || 0;
    const used = myRequests
      .filter(r=>r.leaveType==="Annual Leave"&&r.status==="Approved"&&r.startDate>=cs&&r.startDate<=ce)
      .reduce((s,r)=>s+(r.workDays||0),0);
    const remaining = ent - used;

    // Check if request crosses cycle end
    const crossesExpiry = end > ce;

    if (crossesExpiry) {
      warnEl.innerHTML = `⚠️ This request extends beyond your entitlement expiry date (<strong>${fmtDate(ce)}</strong>). Only days up to expiry will be counted. Please split your request or wait for renewal.`;
      warnEl.style.display = "block";
    } else if (days > remaining) {
      warnEl.innerHTML = `⚠️ You only have <strong>${remaining}</strong> days remaining but selected <strong>${days}</strong> days.`;
      warnEl.style.display = "block";
    }

    // Max requests check (shift=3, GD=4)
    const maxReq = SHIFT_GROUPS.includes(EMP.groupId) ? 3 : 4;
    const reqCount = annualLeaveRequestsThisCycle(ME.uid, myRequests, EMP.joinDate);
    if (reqCount >= maxReq) {
      warnEl.innerHTML = `⚠️ You have reached the maximum of <strong>${maxReq}</strong> Annual Leave requests for this cycle.`;
      warnEl.style.display = "block";
    }
  }
}

async function submitRequest(e) {
  e.preventDefault();
  const errEl = document.getElementById("formError");
  const btn   = e.target.querySelector("button[type=submit]");
  errEl.textContent=""; btn.disabled=true; btn.textContent="Submitting…";

  const start = document.getElementById("fStartDate").value;
  const end   = document.getElementById("fEndDate").value;
  const type  = document.getElementById("fLeaveType").value;
  const notes = document.getElementById("fNotes").value.trim();

  if (!start||!end||end<start) { errEl.textContent="Invalid dates."; btn.disabled=false; btn.textContent="Submit Request"; return; }

  const days = countLeaveDays(start, end);
  if (days===0) { errEl.textContent="No working days (Mon–Thu) in selected range."; btn.disabled=false; btn.textContent="Submit Request"; return; }

  // Check entitlement for annual leave
  if (type==="Annual Leave" && EMP.joinDate) {
    const maxReq = SHIFT_GROUPS.includes(EMP.groupId) ? 3 : 4;
    const reqCount = annualLeaveRequestsThisCycle(ME.uid, myRequests, EMP.joinDate);
    if (reqCount >= maxReq) {
      errEl.textContent=`Maximum ${maxReq} Annual Leave requests per cycle.`;
      btn.disabled=false; btn.textContent="Submit Request"; return;
    }
    const { start:cs, end:ce } = getCurrentCycle(EMP.joinDate);
    const used = myRequests.filter(r=>r.leaveType==="Annual Leave"&&r.status==="Approved"&&r.startDate>=cs&&r.startDate<=ce).reduce((s,r)=>s+(r.workDays||0),0);
    const remaining = (EMP.entitlement||0) - used;
    if (days > remaining) {
      errEl.textContent=`Insufficient leave balance. ${remaining} day(s) remaining.`;
      btn.disabled=false; btn.textContent="Submit Request"; return;
    }
  }

  // Build approval chain
  const chain = getApprovalChain(EMP.groupId, EMP.role);

  try {
    await addDoc(collection(db,"leaveRequests"), {
      employeeId:   ME.uid,
      employeeName: EMP.name,
      groupId:      EMP.groupId || null,
      dept:         EMP.dept || "DO",
      leaveType:    type,
      startDate:    start,
      endDate:      end,
      workDays:     days,
      notes,
      status:       "Pending",
      approvalChain: chain,
      approvals:    {},
      currentLevel: 0,
      editRequested: false,
      createdAt:    serverTimestamp()
    });

    // Notify first approver in chain
    await notifyFirstApprover(chain, type, start, end, days, notes);

    toast("✅ Leave request submitted successfully.");
    document.getElementById("requestForm").reset();
    calSelStart=null; calSelEnd=null;
    document.getElementById("daysPreview").style.display="none";
    document.getElementById("leaveWarning").style.display="none";
    renderCalendar();
    showSection("history");
  } catch(err) {
    errEl.textContent="Failed to submit: "+err.message;
  } finally {
    btn.disabled=false; btn.textContent="Submit Request";
  }
}

async function notifyFirstApprover(chain, type, start, end, days, notes) {
  if (!chain.length) return;
  const firstRole = chain[0];
  // Find approvers with this role in the same group
  try {
    const { getDocs, query: q, collection: col, where: wh } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
    const snap = await getDocs(q(col(db,"employees"), wh("groupId","==",EMP.groupId), wh("role","==",firstRole)));
    const approvers = snap.docs.map(d=>d.data().email).filter(Boolean);
    for (const email of approvers) {
      await sendEmail(email,
        `New Leave Request — ${EMP.name}`,
        `A leave request requires your approval.\n\nEmployee: ${EMP.name}\nGroup: ${EMP.groupId}\nType: ${type}\nFrom: ${fmtDate(start)}\nTo: ${fmtDate(end)}\nDays: ${days}\n${notes?"Notes: "+notes+"\n":""}\nPlease log in to the system to review.\n\nhttps://aes-leave-system.web.app`
      );
    }
  } catch(err) { console.warn("Notify approver failed:", err); }
}

// ── History ───────────────────────────────────────────────────────
function renderHistory() {
  const filter = document.getElementById("histFilter")?.value || "all";
  let list = [...myRequests];
  if (filter!=="all") list = list.filter(r=>r.status===filter);
  const el = document.getElementById("histList");
  if (!list.length) { el.innerHTML=`<div class="empty-state">No requests found.</div>`; return; }

  el.innerHTML = list.map(r=>`
    <div class="req-card">
      <div class="req-card-head">
        <div>
          <div class="req-type">${r.leaveType}</div>
          <div class="req-dates">${fmtDate(r.startDate)} — ${fmtDate(r.endDate)} · <strong>${r.workDays||0} day(s)</strong></div>
        </div>
        ${statusBadge(r.status)}
      </div>
      ${r.notes?`<div class="req-notes">${r.notes}</div>`:""}
      <div class="approval-trail">${renderTrail(r)}</div>
      ${r.rejectionReason?`<div class="req-rejection">Rejected: ${r.rejectionReason}</div>`:""}
      <div class="req-actions">
        ${r.status==="Pending"?`
          <button class="btn-outline-sm" onclick="openEditModal('${r.id}')">Edit</button>
          <button class="btn-ghost-sm" onclick="cancelReq('${r.id}')">Cancel</button>`:""}
        ${["Approved","Approved (Officer)","Approved (Supervisor)","Approved (Admin)","Approved (Section Head)"].includes(r.status) && !r.editRequested?`
          <button class="btn-outline-sm" onclick="requestEdit('${r.id}')">Request Edit</button>`:""}
        ${r.editRequested && r.status!=="EditAllowed"?`<span class="edit-pending-label">Edit pending approval</span>`:""}
        ${r.status==="EditAllowed"?`<button class="btn-outline-sm" onclick="openEditModal('${r.id}')">Edit Now</button>`:""}
      </div>
    </div>`).join("");
}

function renderTrail(r) {
  const chain = r.approvalChain || [];
  const approvals = r.approvals || {};
  return `<div class="trail">${chain.map((role,i)=>{
    const a = approvals[i];
    const dot = a ? (a.status==="approved"?"trail-approved":"trail-rejected") : "trail-pending";
    const label = a ? `${a.by||""} ${a.status==="approved"?"✓":"✗"}` : role;
    return `<div class="trail-step ${dot}">
      <div class="trail-dot"></div>
      <div class="trail-label">${label}</div>
    </div>`;
  }).join("")}</div>`;
}

// ── Edit & Cancel ─────────────────────────────────────────────────
window.openEditModal = (reqId) => {
  const r = myRequests.find(x=>x.id===reqId);
  if (!r) return;
  document.getElementById("editReqId").value        = reqId;
  document.getElementById("editStart").value        = r.startDate;
  document.getElementById("editEnd").value          = r.endDate;
  document.getElementById("editLeaveType").value    = r.leaveType;
  document.getElementById("editNotes").value        = r.notes||"";
  document.getElementById("editFormError").textContent="";
  document.getElementById("editModal").style.display="flex";
};

document.getElementById("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("editFormError");
  const reqId = document.getElementById("editReqId").value;
  const start = document.getElementById("editStart").value;
  const end   = document.getElementById("editEnd").value;
  const type  = document.getElementById("editLeaveType").value;
  const notes = document.getElementById("editNotes").value.trim();
  if (!start||!end||end<start) { errEl.textContent="Invalid dates."; return; }
  const days = countLeaveDays(start, end);
  if (days===0) { errEl.textContent="No working days in range."; return; }
  const chain = getApprovalChain(EMP.groupId, EMP.role);
  try {
    await updateDoc(doc(db,"leaveRequests",reqId),{
      startDate:start, endDate:end, leaveType:type, workDays:days, notes,
      status:"Pending", editRequested:false,
      approvalChain:chain, approvals:{}, currentLevel:0,
    });
    toast("✅ Request updated and resubmitted.");
    document.getElementById("editModal").style.display="none";
    await notifyFirstApprover(chain, type, start, end, days, notes);
  } catch(err) { errEl.textContent="Failed: "+err.message; }
});

window.requestEdit = async (reqId) => {
  if (!confirm("Request approval to edit this leave?")) return;
  await updateDoc(doc(db,"leaveRequests",reqId), { editRequested:true });
  toast("Edit request sent to your approver.");
};

window.cancelReq = async (reqId) => {
  if (!confirm("Cancel this leave request?")) return;
  await updateDoc(doc(db,"leaveRequests",reqId), { status:"Cancelled" });
  toast("Request cancelled.");
};

["editModalClose","editModalCancel"].forEach(id=>
  document.getElementById(id)?.addEventListener("click",()=>document.getElementById("editModal").style.display="none")
);

// ── Change password ───────────────────────────────────────────────
document.getElementById("changePwBtn")?.addEventListener("click",()=>{
  document.getElementById("changePwForm").reset();
  document.getElementById("changePwErr").textContent="";
  document.getElementById("changePwOk").textContent="";
  document.getElementById("changePwModal").style.display="flex";
});
["changePwClose","changePwCancel"].forEach(id=>
  document.getElementById(id)?.addEventListener("click",()=>document.getElementById("changePwModal").style.display="none")
);
document.getElementById("changePwForm").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const errEl=document.getElementById("changePwErr");
  const okEl=document.getElementById("changePwOk");
  errEl.textContent=""; okEl.textContent="";
  const cur=document.getElementById("cpCurrent").value;
  const nw=document.getElementById("cpNew").value;
  const cf=document.getElementById("cpConfirm").value;
  if(nw.length<6){errEl.textContent="Min 6 characters.";return;}
  if(nw!==cf){errEl.textContent="Passwords don't match.";return;}
  try{
    const cred=EmailAuthProvider.credential(ME.email,cur);
    await reauthenticateWithCredential(ME,cred);
    await updatePassword(ME,nw);
    okEl.textContent="✅ Password updated.";
    document.getElementById("changePwForm").reset();
  }catch(err){
    errEl.textContent=err.code==="auth/wrong-password"||err.code==="auth/invalid-credential"
      ?"Current password incorrect.":"Error: "+err.message;
  }
});

// ── Setup & Nav ───────────────────────────────────────────────────
function setupListeners() {
  document.getElementById("fStartDate").addEventListener("change", ()=>{calSelStart=document.getElementById("fStartDate").value;renderCalendar();updatePreview();});
  document.getElementById("fEndDate").addEventListener("change",   ()=>{calSelEnd=document.getElementById("fEndDate").value;renderCalendar();updatePreview();});
  document.getElementById("fLeaveType").addEventListener("change", updatePreview);
  document.getElementById("histFilter").addEventListener("change", renderHistory);
  document.getElementById("requestForm").addEventListener("submit", submitRequest);
  document.getElementById("logoutBtn").addEventListener("click",()=>signOut(auth).then(()=>window.location.href="../index.html"));
}

function initNav() {
  document.querySelectorAll(".bnav-btn").forEach(btn=>{
    btn.addEventListener("click",()=>showSection(btn.dataset.sec));
  });
}

export function showSection(id) {
  document.querySelectorAll(".staff-section").forEach(s=>s.classList.remove("active"));
  document.querySelectorAll(".bnav-btn").forEach(b=>b.classList.remove("active"));
  document.getElementById("sec-"+id)?.classList.add("active");
  document.querySelector(`.bnav-btn[data-sec="${id}"]`)?.classList.add("active");
  if (id==="request") { renderCalendar(); }
}
window.showSection = showSection;
