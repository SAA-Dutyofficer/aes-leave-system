// js/manager.js — AES Leave Management System
import { auth, db } from "./firebase.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, createUserWithEmailAndPassword }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, updateDoc, addDoc,
         onSnapshot, serverTimestamp, query, orderBy, where, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fmtDate, todayStr, cycleEnd, statusBadge, roleBadge,
         toast, SHIFT_GROUPS, ALL_GROUPS, ROLES, pbar } from "./utils.js";

let MGR = {}, employees = [], allRequests = [], editingEmpId = null;

// ── Secondary app to create users without signing manager out ────
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
});

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

// ── Navigation ────────────────────────────────────────────────────
function initUI() {
  // Nav clicks
  document.querySelectorAll(".sidenav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sidenav-item").forEach(b=>b.classList.remove("active"));
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

  // Show dashboard by default
  showSection("dashboard");
}

function showSection(id) {
  document.querySelectorAll(".page-section").forEach(s=>s.classList.remove("active"));
  document.querySelectorAll(".sidenav-item").forEach(b=>b.classList.remove("active"));
  document.getElementById("section-"+id)?.classList.add("active");
  document.querySelector(`.sidenav-item[data-section="${id}"]`)?.classList.add("active");
}
