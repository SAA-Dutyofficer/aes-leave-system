// js/manager.js — AES Leave Management System
import { auth, db } from "./firebase.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, createUserWithEmailAndPassword }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
         onSnapshot, serverTimestamp, query, orderBy, where, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fmtDate, fmtDateTime, todayStr, cycleEnd, statusBadge, roleBadge,
         toast, LEAVE_TYPES, SHIFT_GROUPS, GD_SECTIONS, ALL_GROUPS, ROLES, pbar } from "./utils.js";

let MGR = {}, employees = [], allRequests = [], editingEmpId = null;

// ── Secondary Firebase app (create users without signing manager out) ──
function getSecondaryAuth() {
  const existing = getApps().find(a => a.name === "secondary");
  const app2 = existing || initializeApp({
    apiKey: "AIzaSyBuOsM7NyqWdZf0WrieMe_eFTDjgFvGI70",
    authDomain: "aes-leave-system.firebaseapp.com",
    projectId: "aes-leave-system",
    storageBucket: "aes-leave-system.firebasestorage.app",
    messagingSenderId: "358624876237",
    appId: "1:358624876237:web:779ca2e8a53997418f3b84"
  }, "secondary");
  return getAuth(app2);
}

// ── Auth guard ───────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "../index.html"; return; }
  const snap = await getDoc(doc(db,"users",user.uid));
  if (!snap.exists()) { window.location.href = "../index.html"; return; }
  const data = snap.data();
  if (!["officer","fire_admin","head_ops"].includes(data.role)) {
    window.location.href = "../index.html"; return;
  }
  MGR = { uid: user.uid, ...data };
  document.getElementById("navName").textContent = MGR.name || user.email;
  document.getElementById("navRole").textContent = ROLES[MGR.role] || MGR.role;
  setupUI();
  loadData();
});

// ── Data listeners ───────────────────────────────────────────────
function loadData() {
  onSnapshot(query(collection(db,"employees"), orderBy("name")), snap => {
    employees = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderEmployees();
    renderDashboard();
  });

  onSnapshot(query(collection(db,"leaveRequests"), orderBy("createdAt","desc")), snap => {
    allRequests = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    renderApprovals();
    renderDashboard();
    renderAllLeave();
  });
}

// ── Dashboard ────────────────────────────────────────────────────
function renderDashboard() {
  const today = todayStr();
  const onLeave   = allRequests.filter(r => r.status==="Approved" && r.startDate<=today && r.endDate>=today).length;
  const pending   = allRequests.filter(r => needsMyApproval(r)).length;
  const totalEmp  = employees.length;

  document.getElementById("statOnLeave").textContent  = onLeave;
  document.getElementById("statPending").textContent  = pending;
  document.getElementById("statTotal").textContent    = totalEmp;

  // Per-shift breakdown
  const shiftEl = document.getElementById("shiftBreakdown");
  shiftEl.innerHTML = SHIFT_GROUPS.map(g => {
    const onLeaveInGroup = allRequests.filter(r =>
      r.status==="Approved" && r.groupId===g && r.startDate<=today && r.endDate>=today
    ).length;
    const cls = onLeaveInGroup >= 4 ? "stat-danger" : onLeaveInGroup >= 3 ? "stat-warn" : "";
    return `<div class="shift-stat ${cls}">
      <div class="ss-name">${g}</div>
      <div class="ss-count">${onLeaveInGroup}</div>
      <div class="ss-label">on leave</div>
    </div>`;
  }).join("");
}

// ── Approval logic ───────────────────────────────────────────────
function needsMyApproval(r) {
  if (r.status === "Approved" || r.status === "Rejected" || r.status === "Cancelled") return false;
  if (MGR.role === "officer") {
    // Officer approves first — only requests from their group with no officer decision yet
    return !r.officerStatus && (MGR.groupId ? r.groupId === MGR.groupId : true);
  }
  if (MGR.role === "fire_admin") {
    // Fire admin approves after officer
    return r.officerStatus === "approved" && !r.adminStatus;
  }
  if (MGR.role === "head_ops") {
    // Head of ops approves last
    return r.adminStatus === "approved" && !r.headOpsStatus;
  }
  return false;
}

function renderApprovals() {
  const queue = allRequests.filter(r => needsMyApproval(r));
  const el = document.getElementById("approvalList");

  if (!queue.length) {
    el.innerHTML = `<div class="list-empty">No requests pending your approval.</div>`; return;
  }

  el.innerHTML = queue.map(r => {
    const emp = employees.find(e => e.id === r.employeeId);
    // Clash check
    const groupRequests = allRequests.filter(x => x.groupId===r.groupId && x.id!==r.id);
    const clashCount = groupRequests.filter(x =>
      ["Approved","Approved (Officer)","Approved (Admin)"].includes(x.status) &&
      !(x.endDate < r.startDate || x.startDate > r.endDate)
    ).length;

    return `<div class="approval-card">
      <div class="ac-head">
        <div class="ac-info">
          <div class="ac-name">${r.employeeName}</div>
          <div class="ac-meta">${r.groupId||""} · ${r.dept||""} · ${r.leaveType}</div>
        </div>
        ${statusBadge(r.status)}
      </div>
      <div class="ac-dates">📅 ${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · <strong>${r.workDays||0} day(s)</strong></div>
      ${r.notes ? `<div class="ac-notes">📝 ${r.notes}</div>` : ""}
      ${clashCount >= 4 ? `<div class="clash-alert">⚠️ ${clashCount} others from this shift are already on leave during this period. Acknowledge before approving.</div>` : ""}
      <div class="ac-trail">${renderTrail(r)}</div>
      <div class="ac-actions">
        <button class="btn btn-success btn-sm" onclick="approveRequest('${r.id}')">✅ Approve</button>
        <button class="btn btn-danger btn-sm"  onclick="openRejectModal('${r.id}')">❌ Reject</button>
      </div>
    </div>`;
  }).join("");
}

function renderTrail(r) {
  const steps = [
    { label:"Officer",     status:r.officerStatus, by:r.officerName },
    { label:"Fire Admin",  status:r.adminStatus,   by:r.adminName },
    { label:"Head of Ops", status:r.headOpsStatus, by:r.headOpsName },
  ];
  return `<div class="approval-trail">${steps.map(s => `
    <div class="at-step ${s.status||"pending"}">
      <span class="at-dot">${s.status==="approved"?"✅":s.status==="rejected"?"❌":"⏳"}</span>
      <span class="at-label">${s.label}</span>
      ${s.by?`<span class="at-by">${s.by}</span>`:""}
    </div>`).join("")}</div>`;
}

window.approveRequest = async (reqId) => {
  const r = allRequests.find(x => x.id===reqId);
  if (!r) return;

  // Clash warning acknowledgement for 4+
  const groupRequests = allRequests.filter(x => x.groupId===r.groupId && x.id!==reqId);
  const clashCount = groupRequests.filter(x =>
    ["Approved","Approved (Officer)","Approved (Admin)"].includes(x.status) &&
    !(x.endDate < r.startDate || x.startDate > r.endDate)
  ).length;
  if (clashCount >= 4) {
    if (!confirm(`⚠️ WARNING: ${clashCount} other staff from ${r.groupId} are already on leave during this period.\n\nDo you still want to approve this request?`)) return;
  }

  const updates = {};
  let newStatus = "Pending";

  if (MGR.role === "officer") {
    updates.officerStatus = "approved";
    updates.officerName   = MGR.name;
    updates.officerAt     = serverTimestamp();
    newStatus = "Approved (Officer)";
  } else if (MGR.role === "fire_admin") {
    updates.adminStatus = "approved";
    updates.adminName   = MGR.name;
    updates.adminAt     = serverTimestamp();
    newStatus = "Approved (Admin)";
  } else if (MGR.role === "head_ops") {
    updates.headOpsStatus = "approved";
    updates.headOpsName   = MGR.name;
    updates.headOpsAt     = serverTimestamp();
    newStatus = "Approved";
    // Update employee leave balance on final approval
    const emp = employees.find(e => e.id===r.employeeId);
    if (emp && r.leaveType==="Annual Leave") {
      await updateDoc(doc(db,"employees",r.employeeId), {
        leaveUsed: (emp.leaveUsed||0) + (r.workDays||0)
      });
    }
  }

  updates.status = newStatus;
  await updateDoc(doc(db,"leaveRequests",reqId), updates);
  toast("✅ Request approved!");
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
  if (!reason) { toast("Please provide a rejection reason.","error"); return; }

  const updates = { status:"Rejected", rejectionReason:reason };
  if (MGR.role==="officer")    { updates.officerStatus="rejected"; updates.officerName=MGR.name; updates.officerAt=serverTimestamp(); }
  if (MGR.role==="fire_admin") { updates.adminStatus="rejected";   updates.adminName=MGR.name;   updates.adminAt=serverTimestamp(); }
  if (MGR.role==="head_ops")   { updates.headOpsStatus="rejected"; updates.headOpsName=MGR.name; updates.headOpsAt=serverTimestamp(); }

  await updateDoc(doc(db,"leaveRequests",reqId), updates);
  document.getElementById("rejectModal").style.display = "none";
  toast("Request rejected.");
});

// ── All Leave view ───────────────────────────────────────────────
function renderAllLeave() {
  const filter = document.getElementById("leaveFilter").value;
  const search = document.getElementById("leaveSearch").value.toLowerCase();
  let list = [...allRequests];
  if (filter !== "all") list = list.filter(r => r.status === filter);
  if (search) list = list.filter(r => r.employeeName?.toLowerCase().includes(search));

  const el = document.getElementById("allLeaveList");
  if (!list.length) { el.innerHTML=`<div class="list-empty">No records found.</div>`; return; }

  el.innerHTML = `<table class="data-table">
    <thead><tr>
      <th>Employee</th><th>Group</th><th>Type</th>
      <th>Start</th><th>End</th><th>Days</th><th>Status</th>
    </tr></thead>
    <tbody>${list.map(r=>`<tr>
      <td>${r.employeeName||"--"}</td>
      <td>${r.groupId||"--"}</td>
      <td>${r.leaveType||"--"}</td>
      <td>${fmtDate(r.startDate)}</td>
      <td>${fmtDate(r.endDate)}</td>
      <td>${r.workDays||0}</td>
      <td>${statusBadge(r.status)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

// ── Employees ────────────────────────────────────────────────────
function renderEmployees() {
  const search = (document.getElementById("empSearch")?.value||"").toLowerCase();
  const grpFilter = document.getElementById("empGroupFilter")?.value || "all";
  let list = [...employees];
  if (search) list = list.filter(e => e.name?.toLowerCase().includes(search) || e.email?.toLowerCase().includes(search));
  if (grpFilter !== "all") list = list.filter(e => e.groupId === grpFilter);

  const el = document.getElementById("empList");
  if (!list.length) { el.innerHTML=`<div class="list-empty">No employees found.</div>`; return; }

  el.innerHTML = list.map(emp => {
    const used = allRequests.filter(r =>
      r.employeeId===emp.id && r.leaveType==="Annual Leave" && r.status==="Approved"
    ).reduce((s,r)=>s+(r.workDays||0),0);
    return `<div class="emp-card">
      <div class="ec-avatar">${(emp.name||"?")[0]}</div>
      <div class="ec-info">
        <div class="ec-name">${emp.name}</div>
        <div class="ec-meta">${emp.groupId||""} · ${emp.dept||""} · ${roleBadge(emp.role)}</div>
        <div class="ec-balance">${pbar(used, emp.entitlement)} <span class="ec-days">${used}/${emp.entitlement||0} days used</span></div>
      </div>
      <div class="ec-actions">
        <button class="btn btn-ghost btn-sm" onclick="openEditEmp('${emp.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteEmp('${emp.id}','${emp.name}')">Delete</button>
      </div>
    </div>`;
  }).join("");
}

// ── Employee form ────────────────────────────────────────────────
document.getElementById("addEmpBtn").addEventListener("click", () => {
  editingEmpId = null;
  document.getElementById("empForm").reset();
  document.getElementById("empFormUid").value    = "";
  document.getElementById("efEmail").disabled    = false;
  document.getElementById("efShiftGroup").style.display = "flex";
  populateGroupDropdown(null);
  openEmpModal("Add Employee");
});

function openEmpModal(title) {
  document.getElementById("empModalTitle").textContent  = title;
  document.getElementById("empFormError").textContent   = "";
  document.getElementById("empFormSubmit").textContent  = editingEmpId ? "Save Changes" : "Add Employee";
  document.getElementById("empModal").style.display     = "flex";
}

function populateGroupDropdown(selectedGroup) {
  const sel = document.getElementById("efGroup");
  sel.innerHTML = `<option value="">No Group</option>` +
    ALL_GROUPS.map(g => `<option value="${g}"${g===selectedGroup?" selected":""}>${g}</option>`).join("");
}

document.getElementById("efDept").addEventListener("change", e => {
  document.getElementById("efShiftGroup").style.display = e.target.value==="DO" ? "flex" : "none";
});

window.openEditEmp = (empId) => {
  const emp = employees.find(e => e.id===empId);
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
  document.getElementById("efShiftGroup").style.display = emp.dept==="DO" ? "flex" : "none";
  populateGroupDropdown(emp.groupId);
  openEmpModal("Edit Employee");
};

document.getElementById("empForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("empFormError");
  const btnEl = document.getElementById("empFormSubmit");
  errEl.textContent = "";
  btnEl.disabled = true;
  btnEl.textContent = "Saving…";

  const name        = document.getElementById("efName").value.trim();
  const email       = document.getElementById("efEmail").value.trim().toLowerCase();
  const password    = document.getElementById("efPassword").value;
  const role        = document.getElementById("efRole").value;
  const dept        = document.getElementById("efDept").value;
  const pattern     = dept==="DO" ? (document.getElementById("efPattern").value.trim()||"2W2N4O") : "";
  const joinDate    = document.getElementById("efJoinDate").value;
  const cycleStart  = document.getElementById("efCycleStart").value;
  const entitlement = parseInt(document.getElementById("efEntitlement").value);
  const groupId     = document.getElementById("efGroup").value || null;
  const rosterStart = dept==="DO" ? cycleStart : null;

  if (!name||!email||!joinDate||!cycleStart||!entitlement||isNaN(entitlement)) {
    errEl.textContent="Please fill all required fields.";
    btnEl.disabled=false; btnEl.textContent=editingEmpId?"Save Changes":"Add Employee"; return;
  }
  if (!editingEmpId && !password) {
    errEl.textContent="Password required for new employees.";
    btnEl.disabled=false; btnEl.textContent="Add Employee"; return;
  }
  if (!editingEmpId && password.length<6) {
    errEl.textContent="Password must be at least 6 characters.";
    btnEl.disabled=false; btnEl.textContent="Add Employee"; return;
  }

  const cycleEndDate = cycleEnd(cycleStart);

  try {
    if (!editingEmpId) {
      const secondaryAuth = getSecondaryAuth();
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      const uid  = cred.user.uid;
      await secondaryAuth.signOut();

      const batch = writeBatch(db);
      batch.set(doc(db,"users",uid),      { name, email, role, dept, createdAt:serverTimestamp() });
      batch.set(doc(db,"employees",uid),  {
        name, email, dept, pattern, joinDate,
        cycleStart, cycleEnd:cycleEndDate, rosterStart,
        entitlement, leaveUsed:0, unpaidUsed:0,
        groupId, role, cycleId:`${uid}_${cycleStart}`,
        createdAt:serverTimestamp()
      });
      await batch.commit();
      toast(`✅ ${name} added successfully!`);
    } else {
      const batch = writeBatch(db);
      batch.update(doc(db,"employees",editingEmpId), {
        name, dept, pattern, joinDate,
        cycleStart, cycleEnd:cycleEndDate, rosterStart,
        entitlement, groupId, role
      });
      batch.update(doc(db,"users",editingEmpId), { name, role, dept });
      await batch.commit();
      toast(`✅ ${name} updated!`);
    }
    document.getElementById("empModal").style.display="none";
    document.getElementById("efEmail").disabled=false;
    editingEmpId=null;
  } catch(err) {
    if (err.code==="auth/email-already-in-use") errEl.textContent="❌ Email already registered.";
    else if (err.code==="auth/invalid-email")   errEl.textContent="❌ Invalid email address.";
    else if (err.code==="auth/weak-password")   errEl.textContent="❌ Password too weak (min 6 chars).";
    else errEl.textContent="❌ "+err.message;
  } finally {
    btnEl.disabled=false;
    btnEl.textContent=editingEmpId?"Save Changes":"Add Employee";
  }
});

window.deleteEmp = async (empId, name) => {
  if (!confirm(`Delete ${name}? This will remove their employee record but NOT their login account.`)) return;
  try {
    await updateDoc(doc(db,"employees",empId), { deleted:true, deletedAt:serverTimestamp() });
    toast(`${name} removed.`);
  } catch(err) { toast("Error: "+err.message,"error"); }
};

["empModalClose","empModalCancel"].forEach(id => {
  document.getElementById(id)?.addEventListener("click", () => {
    document.getElementById("empModal").style.display="none";
    document.getElementById("efEmail").disabled=false;
    editingEmpId=null;
  });
});

["rejectModalClose","rejectModalCancel"].forEach(id => {
  document.getElementById(id)?.addEventListener("click", () => {
    document.getElementById("rejectModal").style.display="none";
  });
});

// ── Navigation ───────────────────────────────────────────────────
function setupUI() {
  document.querySelectorAll(".sidenav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sidenav-item").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      showSection(btn.dataset.section);
    });
  });

  document.getElementById("logoutBtn").addEventListener("click", () =>
    signOut(auth).then(()=>window.location.href="../index.html")
  );

  document.getElementById("leaveFilter").addEventListener("change", renderAllLeave);
  document.getElementById("leaveSearch").addEventListener("input",  renderAllLeave);
  document.getElementById("empSearch").addEventListener("input",    renderEmployees);
  document.getElementById("empGroupFilter").addEventListener("change", renderEmployees);

  // Populate group filter
  const gf = document.getElementById("empGroupFilter");
  gf.innerHTML = `<option value="all">All Groups</option>` +
    ALL_GROUPS.map(g=>`<option value="${g}">${g}</option>`).join("");

  // Role-based UI
  if (MGR.role==="officer") {
    document.getElementById("addEmpBtn").style.display="none";
  }
}

function showSection(id) {
  document.querySelectorAll(".page-section").forEach(s=>s.classList.remove("active"));
  document.getElementById("section-"+id)?.classList.add("active");
}
