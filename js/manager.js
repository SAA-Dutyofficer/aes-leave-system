// js/manager.js — AES Leave Management System
import { auth, db } from "./firebase.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, createUserWithEmailAndPassword,
         EmailAuthProvider, reauthenticateWithCredential, updatePassword }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, updateDoc, addDoc,
         onSnapshot, serverTimestamp, query, orderBy, where, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fmtDate, todayStr, cycleEnd, statusBadge, roleBadge,
         toast, SHIFT_GROUPS, ALL_GROUPS, ROLES, pbar } from "./utils.js";
import { sendEmail } from "./email.js";

let MGR = {}, employees = [], allRequests = [], editingEmpId = null;

// ── Secondary app to create users without signing manager out ────
function getSecondaryAuth() {
  const existing = getApps().find(a => a.name === "secondary");
  const app2 = existing || initializeApp({
    apiKey: "AIzaSyBuOsM7NyqWdZf0WrieMe_eFTDjgFvGI70",
    authDomain: "aes-leave-system.web.app",
    projectId: "aes-leave-system",
    storageBucket: "aes-leave-system.firebasestorage.app",
    messagingSenderId: "358624876237",
    appId: "1:358624876237:web:779ca2e8a53997418f3b84"
  }, "secondary");
  return getAuth(app2);
}

// ── Auth ─────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "../index.html"; return; }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) { window.location.href = "../index.html"; return; }
    const data = snap.data();
    if (!["officer","fire_admin","head_ops"].includes(data.role)) {
      window.location.href = "../index.html"; return;
    }
    MGR = { uid: user.uid, ...data };
    document.getElementById("navName").textContent = MGR.name || user.email;
    document.getElementById("navRole").textContent = ROLES[MGR.role] || MGR.role;
    initUI();
    loadData();
  } catch(err) {
    console.error("Auth error:", err);
  }
});

// ── Data ─────────────────────────────────────────────────────────
function loadData() {
  onSnapshot(
    query(collection(db,"employees"), orderBy("name")),
    snap => {
      employees = snap.docs.map(d => ({id:d.id,...d.data()})).filter(e => !e.deleted);
      renderDashboard();
      renderEmployees();
    },
    err => console.error("employees error:", err)
  );

  onSnapshot(
    query(collection(db,"leaveRequests"), orderBy("createdAt","desc")),
    snap => {
      allRequests = snap.docs.map(d => ({id:d.id,...d.data()}));
      renderDashboard();
      renderApprovals();
      renderAllLeave();
      renderClashes();
    },
    err => console.error("leaveRequests error:", err)
  );
}

// ── Dashboard ─────────────────────────────────────────────────────
function renderDashboard() {
  const today    = todayStr();
  const onLeave  = allRequests.filter(r => r.status==="Approved" && r.startDate<=today && r.endDate>=today).length;
  const pending  = allRequests.filter(r => needsMyApproval(r)).length;
  const total    = employees.length;

  document.getElementById("statOnLeave").textContent = onLeave;
  document.getElementById("statPending").textContent = pending;
  document.getElementById("statTotal").textContent   = total;

  document.getElementById("shiftBreakdown").innerHTML = SHIFT_GROUPS.map(g => {
    const count = allRequests.filter(r =>
      r.status==="Approved" && r.groupId===g && r.startDate<=today && r.endDate>=today
    ).length;
    const cls = count >= 4 ? "stat-danger" : count >= 3 ? "stat-warn" : "";
    return `<div class="shift-stat ${cls}">
      <div class="ss-name">${g}</div>
      <div class="ss-count">${count}</div>
      <div class="ss-label">on leave</div>
    </div>`;
  }).join("");
}

// ── Approval logic ────────────────────────────────────────────────
function needsMyApproval(r) {
  if (["Approved","Rejected","Cancelled"].includes(r.status)) return false;
  // All roles can approve at any stage — no waiting for hierarchy
  if (MGR.role === "officer") {
    return !r.officerStatus && (MGR.groupId ? r.groupId===MGR.groupId : true);
  }
  if (MGR.role === "fire_admin") return !r.adminStatus;
  if (MGR.role === "head_ops")   return !r.headOpsStatus;
  return false;
}

// A request is fully approved when all 3 levels have approved
function checkFullyApproved(r, updates) {
  const officerOk   = (updates.officerStatus  || r.officerStatus)  === "approved";
  const adminOk     = (updates.adminStatus     || r.adminStatus)    === "approved";
  const headOpsOk   = (updates.headOpsStatus   || r.headOpsStatus)  === "approved";
  return officerOk && adminOk && headOpsOk;
}

function renderApprovals() {
  const queue = allRequests.filter(r => needsMyApproval(r));
  const el = document.getElementById("approvalList");
  if (!queue.length) { el.innerHTML=`<div class="list-empty">No requests pending your approval.</div>`; return; }

  el.innerHTML = queue.map(r => {
    const clashCount = allRequests.filter(x =>
      x.id!==r.id && x.groupId===r.groupId &&
      ["Approved","Approved (Officer)","Approved (Admin)"].includes(x.status) &&
      !(x.endDate < r.startDate || x.startDate > r.endDate)
    ).length;
    return `<div class="approval-card">
      <div class="ac-head">
        <div class="ac-info">
          <div class="ac-name">${r.employeeName||"--"}</div>
          <div class="ac-meta">${r.groupId||""} · ${r.dept||""} · ${r.leaveType}</div>
        </div>
        ${statusBadge(r.status)}
      </div>
      <div class="ac-dates">📅 ${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · <strong>${r.workDays||0} day(s)</strong></div>
      ${r.notes?`<div class="ac-notes">📝 ${r.notes}</div>`:""}
      ${clashCount>=4?`<div class="clash-alert">⚠️ ${clashCount} others from this shift already on leave during this period.</div>`:""}
      <div class="ac-trail">${renderTrail(r)}</div>
      <div class="ac-actions">
        <button class="btn btn-success btn-sm" onclick="approveRequest('${r.id}')">✅ Approve</button>
        <button class="btn btn-danger btn-sm" onclick="openRejectModal('${r.id}')">❌ Reject</button>
      </div>
      ${r.editRequested ? `
      <div class="clash-alert" style="margin-top:8px">
        ✏️ Staff has requested to edit this approved leave.
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-success btn-sm" onclick="allowEdit('${r.id}')">Allow Edit</button>
          <button class="btn btn-danger btn-sm" onclick="denyEdit('${r.id}')">Deny Edit</button>
        </div>
      </div>` : ""}
    </div>`;
  }).join("");
}

function renderTrail(r) {
  return `<div class="approval-trail">${[
    {label:"Officer",    s:r.officerStatus, by:r.officerName},
    {label:"Fire Admin", s:r.adminStatus,   by:r.adminName},
    {label:"Head of Ops",s:r.headOpsStatus, by:r.headOpsName}
  ].map(x=>`<div class="at-step ${x.s||'pending'}">
    <span class="at-dot">${x.s==="approved"?"✅":x.s==="rejected"?"❌":"⏳"}</span>
    <span class="at-label">${x.label}</span>
    ${x.by?`<span class="at-by">${x.by}</span>`:""}
  </div>`).join("")}</div>`;
}

window.approveRequest = async (reqId) => {
  const r = allRequests.find(x=>x.id===reqId);
  if (!r) return;
  const clashCount = allRequests.filter(x =>
    x.id!==reqId && x.groupId===r.groupId &&
    ["Approved","Approved (Officer)","Approved (Admin)"].includes(x.status) &&
    !(x.endDate < r.startDate || x.startDate > r.endDate)
  ).length;
  if (clashCount>=4 && !confirm(`⚠️ ${clashCount} others from ${r.groupId} already on leave this period.\nApprove anyway?`)) return;

  const u = {};
  if (MGR.role==="officer")    { u.officerStatus="approved";  u.officerName=MGR.name;  u.officerAt=serverTimestamp(); }
  if (MGR.role==="fire_admin") { u.adminStatus="approved";    u.adminName=MGR.name;    u.adminAt=serverTimestamp(); }
  if (MGR.role==="head_ops")   { u.headOpsStatus="approved";  u.headOpsName=MGR.name;  u.headOpsAt=serverTimestamp(); }

  // Check if all 3 levels are now approved → set final status
  if (checkFullyApproved(r, u)) {
    u.status = "Approved";
    const emp = employees.find(e=>e.id===r.employeeId);
    if (emp && r.leaveType==="Annual Leave") {
      await updateDoc(doc(db,"employees",r.employeeId), { leaveUsed:(emp.leaveUsed||0)+(r.workDays||0) });
    }
  } else {
    // Set intermediate status label
    if (MGR.role==="officer")    u.status = "Approved (Officer)";
    if (MGR.role==="fire_admin") u.status = "Approved (Admin)";
    if (MGR.role==="head_ops")   u.status = "Approved (Head Ops)";
  }

  await updateDoc(doc(db,"leaveRequests",reqId), u);
  toast("✅ Approved!");

  // Send email to staff member
  const emp = employees.find(e=>e.id===r.employeeId);
  if (emp?.email) {
    const statusLabel = u.status === "Approved" ? "FULLY APPROVED ✅" : `${u.status}`;
    sendEmail(
      emp.email,
      `Leave Request ${u.status} — AES Leave System`,
      `Hi ${r.employeeName},\n\nYour leave request has been ${statusLabel}.\n\nDetails:\nType: ${r.leaveType}\nFrom: ${fmtDate(r.startDate)}\nTo: ${fmtDate(r.endDate)}\nDays: ${r.workDays||0}\nApproved by: ${MGR.name} (${ROLES[MGR.role]})\n\nAES Leave Management System`
    );
  }
};

window.openRejectModal = (reqId) => {
  document.getElementById("rejectRequestId").value = reqId;
  document.getElementById("rejectReason").value    = "";
  document.getElementById("rejectModal").style.display = "flex";
};

document.getElementById("rejectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const reqId  = document.getElementById("rejectRequestId").value;
  const reason = document.getElementById("rejectReason").value.trim();
  if (!reason) { toast("Provide a rejection reason.","error"); return; }
  const u = { status:"Rejected", rejectionReason:reason };
  if (MGR.role==="officer")    { u.officerStatus="rejected"; u.officerName=MGR.name; u.officerAt=serverTimestamp(); }
  if (MGR.role==="fire_admin") { u.adminStatus="rejected";   u.adminName=MGR.name;   u.adminAt=serverTimestamp(); }
  if (MGR.role==="head_ops")   { u.headOpsStatus="rejected"; u.headOpsName=MGR.name; u.headOpsAt=serverTimestamp(); }
  await updateDoc(doc(db,"leaveRequests",reqId), u);
  document.getElementById("rejectModal").style.display="none";
  toast("Request rejected.");

  // Send email to staff member
  const rejReq = allRequests.find(x=>x.id===reqId);
  const rejEmp = employees.find(e=>e.id===rejReq?.employeeId);
  if (rejEmp?.email) {
    sendEmail(
      rejEmp.email,
      "Leave Request Rejected — AES Leave System",
      `Hi ${rejReq.employeeName},\n\nYour leave request has been REJECTED.\n\nDetails:\nType: ${rejReq.leaveType}\nFrom: ${fmtDate(rejReq.startDate)}\nTo: ${fmtDate(rejReq.endDate)}\nRejected by: ${MGR.name} (${ROLES[MGR.role]})\nReason: ${reason}\n\nPlease contact your approving officer for more information.\n\nAES Leave Management System`
    );
  }
});

window.allowEdit = async (reqId) => {
  try {
    const r = allRequests.find(x=>x.id===reqId);
    await updateDoc(doc(db,"leaveRequests",reqId), { status:"EditAllowed", editRequested:false });
    const emp = employees.find(e=>e.id===r?.employeeId);
    if (emp?.email) sendEmail(emp.email, "Edit Request Approved — AES Leave System",
      `Hi ${r.employeeName},\n\nYour request to edit your leave has been approved.\nPlease log in and make your changes from the History tab.\n\nAES Leave Management System`);
    toast("✅ Edit allowed — staff can now edit their request.");
  } catch(err) { toast("Error: "+err.message,"error"); }
};

window.denyEdit = async (reqId) => {
  try {
    const r = allRequests.find(x=>x.id===reqId);
    await updateDoc(doc(db,"leaveRequests",reqId), { editRequested:false });
    const emp = employees.find(e=>e.id===r?.employeeId);
    if (emp?.email) sendEmail(emp.email, "Edit Request Denied — AES Leave System",
      `Hi ${r.employeeName},\n\nYour request to edit your approved leave has been denied.\nPlease contact your approving officer for more information.\n\nAES Leave Management System`);
    toast("Edit request denied.");
  } catch(err) { toast("Error: "+err.message,"error"); }
};

// ── Clashes ───────────────────────────────────────────────────────
function renderClashes() {
  const today = todayStr();
  const in60  = new Date(); in60.setDate(in60.getDate()+60);
  const in60Str = in60.toISOString().split("T")[0];

  // Today grid
  const todayGrid = document.getElementById("clashTodayGrid");
  if (todayGrid) {
    todayGrid.innerHTML = SHIFT_GROUPS.map(g => {
      const onLeave = allRequests.filter(r =>
        r.status==="Approved" && r.groupId===g && r.startDate<=today && r.endDate>=today
      );
      const cls = onLeave.length>=4?"stat-danger":onLeave.length>=3?"stat-warn":"";
      const names = onLeave.map(r=>r.employeeName).join(", ")||"None";
      return `<div class="shift-stat ${cls}" style="min-width:120px">
        <div class="ss-name">${g}</div>
        <div class="ss-count">${onLeave.length}</div>
        <div class="ss-label">on leave</div>
        <div style="font-size:10px;color:#6b7280;margin-top:4px">${names}</div>
      </div>`;
    }).join("");
  }

  // Upcoming overlaps — find date ranges where 4+ from same shift overlap
  const clashEl = document.getElementById("clashList");
  if (!clashEl) return;

  const upcoming = allRequests.filter(r =>
    !["Rejected","Cancelled"].includes(r.status) &&
    r.endDate >= today && r.startDate <= in60Str
  );

  // Group by shift and find overlaps
  const clashes = [];
  SHIFT_GROUPS.forEach(g => {
    const groupReqs = upcoming.filter(r => r.groupId===g);
    // Check each request against others in same group
    groupReqs.forEach(r => {
      const overlapping = groupReqs.filter(x =>
        x.id !== r.id &&
        !(x.endDate < r.startDate || x.startDate > r.endDate)
      );
      if (overlapping.length >= 3) { // 4+ including r itself
        const key = `${g}-${r.startDate}-${r.endDate}`;
        if (!clashes.find(c => c.key===key)) {
          clashes.push({
            key,
            group: g,
            count: overlapping.length + 1,
            start: r.startDate,
            end:   r.endDate,
            names: [r.employeeName, ...overlapping.map(x=>x.employeeName)].filter((v,i,a)=>a.indexOf(v)===i)
          });
        }
      }
    });
  });

  if (!clashes.length) {
    clashEl.innerHTML=`<div class="list-empty">✅ No overlapping leave detected in the next 60 days.</div>`;
    return;
  }

  clashEl.innerHTML = clashes.map(c => `
    <div class="list-item" style="flex-direction:column;align-items:flex-start;gap:4px">
      <div style="display:flex;align-items:center;gap:8px;width:100%">
        <span style="font-weight:700">${c.group} Shift</span>
        <span class="status-badge ${c.count>=4?"sb-rejected":"sb-pending"}">${c.count} staff overlapping</span>
        <span style="margin-left:auto;font-size:12px;color:#6b7280">${fmtDate(c.start)} → ${fmtDate(c.end)}</span>
      </div>
      <div style="font-size:12px;color:#6b7280">${c.names.join(", ")}</div>
    </div>`).join("");
}

// ── All Leave ─────────────────────────────────────────────────────
function renderAllLeave() {
  const filter = document.getElementById("leaveFilter")?.value || "all";
  const search = (document.getElementById("leaveSearch")?.value||"").toLowerCase();
  let list = [...allRequests];
  if (filter!=="all") list = list.filter(r=>r.status===filter);
  if (search) list = list.filter(r=>r.employeeName?.toLowerCase().includes(search));
  const el = document.getElementById("allLeaveList");
  if (!list.length) { el.innerHTML=`<div class="list-empty">No records found.</div>`; return; }
  el.innerHTML=`<table class="data-table"><thead><tr>
    <th>Employee</th><th>Group</th><th>Type</th><th>Start</th><th>End</th><th>Days</th><th>Status</th>
  </tr></thead><tbody>${list.map(r=>`<tr>
    <td>${r.employeeName||"--"}</td><td>${r.groupId||"--"}</td><td>${r.leaveType||"--"}</td>
    <td>${fmtDate(r.startDate)}</td><td>${fmtDate(r.endDate)}</td>
    <td>${r.workDays||0}</td><td>${statusBadge(r.status)}</td>
  </tr>`).join("")}</tbody></table>`;
}

// ── Employees ─────────────────────────────────────────────────────
function renderEmployees() {
  const search    = (document.getElementById("empSearch")?.value||"").toLowerCase();
  const grpFilter = document.getElementById("empGroupFilter")?.value || "all";
  let list = [...employees];
  if (search)        list = list.filter(e=>e.name?.toLowerCase().includes(search)||e.email?.toLowerCase().includes(search));
  if (grpFilter!=="all") list = list.filter(e=>e.groupId===grpFilter);
  const el = document.getElementById("empList");
  if (!list.length) { el.innerHTML=`<div class="list-empty">No employees found.</div>`; return; }
  el.innerHTML = list.map(emp => {
    const used = allRequests.filter(r=>r.employeeId===emp.id&&r.leaveType==="Annual Leave"&&r.status==="Approved").reduce((s,r)=>s+(r.workDays||0),0);
    return `<div class="emp-card">
      <div class="ec-avatar">${(emp.name||"?")[0].toUpperCase()}</div>
      <div class="ec-info">
        <div class="ec-name">${emp.name}</div>
        <div class="ec-meta">${emp.groupId||""} · ${emp.dept||""} · ${roleBadge(emp.role)}</div>
        <div class="ec-balance">${pbar(used,emp.entitlement)} <span class="ec-days">${used}/${emp.entitlement||0} days used</span></div>
      </div>
      <div class="ec-actions">
        <button class="btn btn-ghost btn-sm" onclick="openEditEmp('${emp.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteEmp('${emp.id}','${emp.name}')">Delete</button>
      </div>
    </div>`;
  }).join("");
}

// ── Employee form ─────────────────────────────────────────────────
function populateGroupDropdown(selected) {
  document.getElementById("efGroup").innerHTML =
    `<option value="">No Group</option>` +
    ALL_GROUPS.map(g=>`<option value="${g}"${g===selected?" selected":""}>${g}</option>`).join("");
}

function openEmpModal(title) {
  document.getElementById("empModalTitle").textContent = title;
  document.getElementById("empFormError").textContent  = "";
  document.getElementById("empFormSubmit").textContent = editingEmpId ? "Save Changes" : "Add Employee";
  document.getElementById("empModal").style.display    = "flex";
}

window.openEditEmp = (empId) => {
  const emp = employees.find(e=>e.id===empId);
  if (!emp) return;
  editingEmpId = empId;
  document.getElementById("efName").value        = emp.name||"";
  document.getElementById("efEmail").value       = emp.email||"";
  document.getElementById("efEmail").disabled    = true;
  document.getElementById("efPassword").value    = "";
  document.getElementById("efRole").value        = emp.role||"staff";
  document.getElementById("efDept").value        = emp.dept||"DO";
  document.getElementById("efPattern").value     = emp.pattern||"2W2N4O";
  document.getElementById("efJoinDate").value    = emp.joinDate||"";
  document.getElementById("efCycleStart").value  = emp.cycleStart||"";
  document.getElementById("efEntitlement").value = emp.entitlement||"";
  document.getElementById("efShiftGroup").style.display = emp.dept==="DO"?"flex":"none";
  populateGroupDropdown(emp.groupId);
  openEmpModal("Edit Employee");
};

document.getElementById("addEmpBtn").addEventListener("click", () => {
  editingEmpId = null;
  document.getElementById("empForm").reset();
  document.getElementById("efEmail").disabled = false;
  document.getElementById("efShiftGroup").style.display = "flex";
  populateGroupDropdown(null);
  openEmpModal("Add Employee");
});

document.getElementById("efDept").addEventListener("change", e => {
  document.getElementById("efShiftGroup").style.display = e.target.value==="DO"?"flex":"none";
});

document.getElementById("empForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("empFormError");
  const btnEl = document.getElementById("empFormSubmit");
  errEl.textContent=""; btnEl.disabled=true; btnEl.textContent="Saving…";

  const name        = document.getElementById("efName").value.trim();
  const email       = document.getElementById("efEmail").value.trim().toLowerCase();
  const password    = document.getElementById("efPassword").value;
  const role        = document.getElementById("efRole").value;
  const dept        = document.getElementById("efDept").value;
  const pattern     = dept==="DO"?(document.getElementById("efPattern").value.trim()||"2W2N4O"):"";
  const joinDate    = document.getElementById("efJoinDate").value;
  const cycleStart  = document.getElementById("efCycleStart").value;
  const entitlement = parseInt(document.getElementById("efEntitlement").value);
  const groupId     = document.getElementById("efGroup").value||null;
  const rosterStart = dept==="DO"?cycleStart:null;

  if (!name||!email||!joinDate||!cycleStart||!entitlement||isNaN(entitlement)) {
    errEl.textContent="Please fill all required fields.";
    btnEl.disabled=false; btnEl.textContent=editingEmpId?"Save Changes":"Add Employee"; return;
  }
  if (!editingEmpId&&!password) {
    errEl.textContent="Password required."; btnEl.disabled=false; btnEl.textContent="Add Employee"; return;
  }
  if (!editingEmpId&&password.length<6) {
    errEl.textContent="Password min 6 characters."; btnEl.disabled=false; btnEl.textContent="Add Employee"; return;
  }

  const cycleEndDate = cycleEnd(cycleStart);
  try {
    if (!editingEmpId) {
      const sa   = getSecondaryAuth();
      const cred = await createUserWithEmailAndPassword(sa, email, password);
      const uid  = cred.user.uid;
      await sa.signOut();
      const b = writeBatch(db);
      b.set(doc(db,"users",uid),     {name,email,role,dept,createdAt:serverTimestamp()});
      b.set(doc(db,"employees",uid), {name,email,dept,pattern,joinDate,cycleStart,cycleEnd:cycleEndDate,rosterStart,entitlement,leaveUsed:0,unpaidUsed:0,groupId,role,createdAt:serverTimestamp()});
      await b.commit();
      toast(`✅ ${name} added!`);
    } else {
      const b = writeBatch(db);
      b.update(doc(db,"employees",editingEmpId),{name,dept,pattern,joinDate,cycleStart,cycleEnd:cycleEndDate,rosterStart,entitlement,groupId,role});
      b.update(doc(db,"users",editingEmpId),{name,role,dept});
      await b.commit();
      toast(`✅ ${name} updated!`);
    }
    document.getElementById("empModal").style.display="none";
    document.getElementById("efEmail").disabled=false;
    editingEmpId=null;
  } catch(err) {
    if (err.code==="auth/email-already-in-use") errEl.textContent="❌ Email already registered.";
    else if (err.code==="auth/invalid-email")   errEl.textContent="❌ Invalid email.";
    else if (err.code==="auth/weak-password")   errEl.textContent="❌ Password too weak.";
    else errEl.textContent="❌ "+err.message;
  } finally {
    btnEl.disabled=false;
    btnEl.textContent=editingEmpId?"Save Changes":"Add Employee";
  }
});

window.deleteEmp = async (empId, name) => {
  if (!confirm(`Delete ${name}?`)) return;
  try { await updateDoc(doc(db,"employees",empId),{deleted:true,deletedAt:serverTimestamp()}); toast(`${name} removed.`); }
  catch(err) { toast("Error: "+err.message,"error"); }
};

["empModalClose","empModalCancel"].forEach(id =>
  document.getElementById(id)?.addEventListener("click", () => {
    document.getElementById("empModal").style.display="none";
    document.getElementById("efEmail").disabled=false;
    editingEmpId=null;
  })
);

["rejectModalClose","rejectModalCancel"].forEach(id =>
  document.getElementById(id)?.addEventListener("click", () => {
    document.getElementById("rejectModal").style.display="none";
  })
);

// ── My Leave ─────────────────────────────────────────────────────
let MY_EMP = null, myOwnRequests = [];

function initMyLeave() {
  if (!MGR.uid) return;
  // Listen to own employee record
  onSnapshot(doc(db,"employees",MGR.uid), snap => {
    if (!snap.exists()) return;
    MY_EMP = { id:snap.id, ...snap.data() };
    renderMyBalance();
  });
  // Listen to own requests
  onSnapshot(
    query(collection(db,"leaveRequests"), where("employeeId","==",MGR.uid), orderBy("createdAt","desc")),
    snap => {
      myOwnRequests = snap.docs.map(d=>({id:d.id,...d.data()}));
      renderMyHistory();
    }
  );
}

function renderMyBalance() {
  if (!MY_EMP) return;
  const cs  = MY_EMP.cycleStart || todayStr();
  const ce  = cycleEnd(cs);
  const ent = MY_EMP.entitlement || 0;
  const used = myOwnRequests.filter(r =>
    r.leaveType==="Annual Leave" && r.status==="Approved" &&
    r.startDate>=cs && r.startDate<=ce
  ).reduce((s,r)=>s+(r.workDays||0),0);
  const unpaid = myOwnRequests.filter(r =>
    r.leaveType==="Unpaid Leave" && r.status==="Approved" &&
    r.startDate>=cs && r.startDate<=ce
  ).reduce((s,r)=>s+(r.workDays||0),0);
  const remaining = Math.max(0, ent-used);
  const pct = ent ? Math.min(100,Math.round(used/ent*100)) : 0;

  document.getElementById("myBcEntitlement").textContent = ent;
  document.getElementById("myBcUsed").textContent        = used;
  document.getElementById("myBcRemaining").textContent   = remaining;
  document.getElementById("myBcUnpaid").textContent      = unpaid;
  document.getElementById("myProgressFill").style.width  = pct+"%";
  document.getElementById("myProgressPct").textContent   = pct+"%";
  document.getElementById("myCycleInfo").textContent     = `Cycle: ${fmtDate(cs)} – ${fmtDate(ce)}`;
}

function updateMyPreview() {
  if (!MY_EMP) return;
  const start = document.getElementById("myFStartDate").value;
  const end   = document.getElementById("myFEndDate").value;
  const type  = document.getElementById("myFLeaveType").value;
  if (!start||!end||end<start) { document.getElementById("myDaysPreview").style.display="none"; return; }

  const s = new Date(start+"T00:00:00"), e = new Date(end+"T00:00:00");
  let days = 0, cur = new Date(s);
  while (cur<=e) {
    const ds = cur.toISOString().split("T")[0];
    const wd = cur.getDay();
    if (MY_EMP.dept==="GD" ? (wd>=1&&wd<=4) : isShiftDay(ds)) days++;
    cur.setDate(cur.getDate()+1);
  }
  document.getElementById("myDaysCount").textContent = days;
  document.getElementById("myDaysPreview").style.display = "block";

  if (type==="Annual Leave") {
    const cs=MY_EMP.cycleStart||todayStr(), ce=cycleEnd(cs);
    const used=myOwnRequests.filter(r=>r.leaveType==="Annual Leave"&&r.status==="Approved"&&r.startDate>=cs&&r.startDate<=ce).reduce((s,r)=>s+(r.workDays||0),0);
    const rem=(MY_EMP.entitlement||0)-used;
    const bw=document.getElementById("myBalanceWarning");
    if (days>rem){bw.style.display="block";bw.textContent=`⚠️ Only ${rem} days remaining.`;}
    else bw.style.display="none";
  } else document.getElementById("myBalanceWarning").style.display="none";
}

function isShiftDay(ds) {
  if (!MY_EMP?.rosterStart) return false;
  const d=new Date(ds+"T00:00:00"), r=new Date(MY_EMP.rosterStart+"T00:00:00");
  const diff=Math.round((d-r)/86400000);
  const pos=((diff%8)+8)%8;
  return pos<4;
}

async function submitMyLeave(e) {
  e.preventDefault();
  if (!MY_EMP) { toast("No employee record found. Ask admin to add you as an employee.","error"); return; }
  const errEl=document.getElementById("myFormError");
  const btn=e.target.querySelector("button[type=submit]");
  errEl.textContent=""; btn.disabled=true; btn.textContent="Submitting…";

  const start   = document.getElementById("myFStartDate").value;
  const end     = document.getElementById("myFEndDate").value;
  const type    = document.getElementById("myFLeaveType").value;
  const notes   = document.getElementById("myFNotes").value.trim();
  const days    = parseInt(document.getElementById("myDaysCount").textContent)||0;

  if (!start||!end||end<start){errEl.textContent="Invalid dates.";btn.disabled=false;btn.textContent="Submit Request";return;}
  if (days===0){errEl.textContent="No working days in selected range.";btn.disabled=false;btn.textContent="Submit Request";return;}

  try {
    await addDoc(collection(db,"leaveRequests"),{
      employeeId:MGR.uid, employeeName:MY_EMP.name||MGR.name,
      groupId:MY_EMP.groupId||null, dept:MY_EMP.dept||"GD",
      leaveType:type, startDate:start, endDate:end, workDays:days, notes,
      status:"Pending",
      officerStatus:null,officerName:null,officerAt:null,
      adminStatus:null,adminName:null,adminAt:null,
      headOpsStatus:null,headOpsName:null,headOpsAt:null,
      createdAt:serverTimestamp()
    });
    toast("✅ Leave request submitted!");
    document.getElementById("myLeaveForm").reset();
    document.getElementById("myDaysPreview").style.display="none";
    document.getElementById("myBalanceWarning").style.display="none";
  } catch(err){errEl.textContent="Failed: "+err.message;}
  finally{btn.disabled=false;btn.textContent="Submit Request";}
}

function renderMyHistory() {
  const el=document.getElementById("myHistoryList");
  if (!myOwnRequests.length){el.innerHTML=`<div class="list-empty">No requests yet.</div>`;return;}
  el.innerHTML=myOwnRequests.map(r=>`
    <div class="request-card">
      <div class="rc-head"><span class="rc-type">${r.leaveType}</span>${statusBadge(r.status)}</div>
      <div class="rc-dates">📅 ${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · <strong>${r.workDays||0} day(s)</strong></div>
      ${r.notes?`<div class="rc-notes">📝 ${r.notes}</div>`:""}
    </div>`).join("");
}

// ── Navigation ────────────────────────────────────────────────────
function initUI() {
  // Desktop sidebar nav
  document.querySelectorAll(".sidenav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sidenav-item").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      showSection(btn.dataset.section);
    });
  });

  // Mobile bottom nav
  document.querySelectorAll(".mgr-bnav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mgr-bnav-item").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      showSection(btn.dataset.section);
    });
  });

  // Logout
  document.getElementById("logoutBtn").addEventListener("click", () =>
    signOut(auth).then(() => window.location.href="../index.html")
  );

  // Filters
  document.getElementById("leaveFilter").addEventListener("change", renderAllLeave);
  document.getElementById("leaveSearch").addEventListener("input",  renderAllLeave);
  document.getElementById("empSearch").addEventListener("input",    renderEmployees);
  document.getElementById("empGroupFilter").addEventListener("change", renderEmployees);

  // Populate group filter
  document.getElementById("empGroupFilter").innerHTML =
    `<option value="all">All Groups</option>` +
    ALL_GROUPS.map(g=>`<option value="${g}">${g}</option>`).join("");

  // Hide add button for officers
  if (MGR.role==="officer") document.getElementById("addEmpBtn").style.display="none";

  // Change password
  document.getElementById("changePwBtn").addEventListener("click", () => {
    document.getElementById("changePwForm").reset();
    document.getElementById("changePwError").textContent   = "";
    document.getElementById("changePwSuccess").textContent = "";
    document.getElementById("changePwModal").style.display = "flex";
  });
  ["changePwModalClose","changePwModalCancel"].forEach(id =>
    document.getElementById(id)?.addEventListener("click", () =>
      document.getElementById("changePwModal").style.display = "none"
    )
  );
  document.getElementById("changePwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl  = document.getElementById("changePwError");
    const succEl = document.getElementById("changePwSuccess");
    errEl.textContent=""; succEl.textContent="";
    const current = document.getElementById("currentPw").value;
    const newPw   = document.getElementById("newPw").value;
    const confirm = document.getElementById("confirmPw").value;
    if (newPw.length < 6) { errEl.textContent="New password must be at least 6 characters."; return; }
    if (newPw !== confirm) { errEl.textContent="Passwords don't match."; return; }
    try {
      const user = auth.currentUser;
      const cred = EmailAuthProvider.credential(user.email, current);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newPw);
      succEl.textContent = "✅ Password updated successfully!";
      document.getElementById("changePwForm").reset();
    } catch(err) {
      if (err.code==="auth/wrong-password" || err.code==="auth/invalid-credential") {
        errEl.textContent = "Current password is incorrect.";
      } else {
        errEl.textContent = "Error: " + err.message;
      }
    }
  });
  document.getElementById("myFEndDate").addEventListener("change",   updateMyPreview);
  document.getElementById("myFLeaveType").addEventListener("change", updateMyPreview);
  document.getElementById("myLeaveForm").addEventListener("submit",  submitMyLeave);

  // Show dashboard by default
  showSection("dashboard");
  initMyLeave();
}

function showSection(id) {
  document.querySelectorAll(".page-section").forEach(s=>s.classList.remove("active"));
  document.querySelectorAll(".sidenav-item").forEach(b=>b.classList.remove("active"));
  document.querySelectorAll(".mgr-bnav-item").forEach(b=>b.classList.remove("active"));
  document.getElementById("section-"+id)?.classList.add("active");
  document.querySelector(`.sidenav-item[data-section="${id}"]`)?.classList.add("active");
  document.querySelector(`.mgr-bnav-item[data-section="${id}"]`)?.classList.add("active");
}
