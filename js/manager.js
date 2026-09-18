// js/manager.js — AES Leave Management System v2
import { auth, db } from "./firebase.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, createUserWithEmailAndPassword,
         EmailAuthProvider, reauthenticateWithCredential, updatePassword }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
         onSnapshot, serverTimestamp, query, orderBy, where, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fmtDate, fmtDateTime, todayStr, getCurrentCycle, daysUntilExpiry,
         countLeaveDays, statusBadge, roleBadge, toast, pbar,
         ROLES, ALL_GROUPS, SHIFT_GROUPS, GD_SECTIONS, LEAVE_TYPES,
         getApprovalChain, APPROVER_ROLES } from "./utils.js";
import { sendEmail } from "./email.js";

let MGR = {}, employees = [], allRequests = [], editingEmpId = null;
let myOwnEmp = null, myOwnRequests = [];

// ── Secondary Firebase app ────────────────────────────────────────
function getSecondaryAuth() {
  const existing = getApps().find(a=>a.name==="secondary");
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

// ── Auth ──────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href="../index.html"; return; }
  try {
    const snap = await getDoc(doc(db,"users",user.uid));
    if (!snap.exists()) { window.location.href="../index.html"; return; }
    const data = snap.data();
    if (!APPROVER_ROLES.includes(data.role)) { window.location.href="../index.html"; return; }
    MGR = { uid:user.uid, ...data };

    // Set UI
    document.getElementById("mgrName").textContent     = MGR.name || user.email;
    document.getElementById("mgrRole").textContent     = ROLES[MGR.role] || MGR.role;
    document.getElementById("mgrInitials").textContent = initials(MGR.name);
    document.getElementById("mgrNameMob").textContent  = MGR.name || user.email;
    document.getElementById("mgrRoleMob").textContent  = ROLES[MGR.role] || MGR.role;

    setupUI();
    loadData();
    loadMyLeave();
  } catch(err) { console.error("Auth error:", err); }
});

function initials(name) {
  if (!name) return "?";
  return name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
}

// ── Data ──────────────────────────────────────────────────────────
function loadData() {
  // Show zeros immediately
  renderDashboard(); renderEmployees(); renderApprovals(); renderAllLeave(); renderClashes();

  onSnapshot(
    query(collection(db,"employees"), orderBy("name")),
    snap => {
      employees = snap.docs.map(d=>({id:d.id,...d.data()})).filter(e=>!e.deleted);
      renderDashboard(); renderEmployees();
    }, err=>console.error("employees:", err)
  );

  onSnapshot(
    query(collection(db,"leaveRequests"), orderBy("createdAt","desc")),
    snap => {
      allRequests = snap.docs.map(d=>({id:d.id,...d.data()}));
      renderDashboard(); renderApprovals(); renderAllLeave(); renderClashes();
    }, err=>console.error("leaveRequests:", err)
  );
}

function loadMyLeave() {
  // My own employee record
  onSnapshot(doc(db,"employees",MGR.uid), snap=>{
    if (!snap.exists()) return;
    myOwnEmp = { id:snap.id, ...snap.data() };
    renderMyLeaveOverview();
  });
  // My own requests
  onSnapshot(
    query(collection(db,"leaveRequests"), where("employeeId","==",MGR.uid), orderBy("createdAt","desc")),
    snap=>{
      myOwnRequests = snap.docs.map(d=>({id:d.id,...d.data()}));
      renderMyLeaveOverview();
      renderMyLeaveHistory();
    }
  );
}

// ── Dashboard ─────────────────────────────────────────────────────
function renderDashboard() {
  const today   = todayStr();
  const onLeave = allRequests.filter(r=>r.status==="Approved"&&r.startDate<=today&&r.endDate>=today).length;
  const pending = allRequests.filter(r=>needsMyApproval(r)).length;

  document.getElementById("statOnLeave").textContent = onLeave;
  document.getElementById("statPending").textContent = pending;
  document.getElementById("statTotal").textContent   = employees.length;

  // Shift breakdown
  const grid = document.getElementById("shiftGrid");
  if (grid) {
    grid.innerHTML = SHIFT_GROUPS.map(g=>{
      const count = allRequests.filter(r=>r.status==="Approved"&&r.groupId===g&&r.startDate<=today&&r.endDate>=today).length;
      const names = allRequests.filter(r=>r.status==="Approved"&&r.groupId===g&&r.startDate<=today&&r.endDate>=today).map(r=>r.employeeName).join(", ")||"None";
      const cls   = count>=4?"scard-danger":count>=3?"scard-warn":"";
      return `<div class="scard ${cls}">
        <div class="scard-name">${g}</div>
        <div class="scard-count">${count}</div>
        <div class="scard-label">on leave</div>
        <div class="scard-names">${names}</div>
      </div>`;
    }).join("");
  }
}

// ── Approval logic ────────────────────────────────────────────────
function needsMyApproval(r) {
  if (["Approved","Rejected","Cancelled"].includes(r.status)) return false;
  const chain   = r.approvalChain || [];
  const level   = r.currentLevel || 0;
  const approvals = r.approvals || {};
  if (level >= chain.length) return false;
  const neededRole = chain[level];
  if (MGR.role !== neededRole) return false;
  // Officers only see their own group
  if (["officer","supervisor"].includes(MGR.role) && MGR.groupId && r.groupId !== MGR.groupId) return false;
  return !approvals[level];
}

function renderApprovals() {
  const editQueue  = allRequests.filter(r=>r.editRequested && canApproveEdit(r));
  const approvalQ  = allRequests.filter(r=>needsMyApproval(r));
  const el = document.getElementById("approvalList");

  if (!approvalQ.length && !editQueue.length) {
    el.innerHTML=`<div class="empty-state">No requests pending your approval.</div>`; return;
  }

  const cards = [...approvalQ, ...editQueue.filter(r=>!approvalQ.find(x=>x.id===r.id))];

  el.innerHTML = cards.map(r=>{
    const clashers = allRequests.filter(x=>
      x.id!==r.id && x.groupId===r.groupId &&
      !["Rejected","Cancelled"].includes(x.status) &&
      !(x.endDate<r.startDate||x.startDate>r.endDate)
    );
    const clashCount = clashers.length;
    const isEditReq  = r.editRequested && !needsMyApproval(r);

    return `<div class="approval-card ${clashCount>=4?"ac-danger":""}">
      <div class="ac-top">
        <div class="ac-meta">
          <div class="ac-name">${r.employeeName}</div>
          <div class="ac-detail">${r.groupId||""} · ${r.leaveType}</div>
        </div>
        ${statusBadge(r.status)}
      </div>
      <div class="ac-dates">📅 ${fmtDate(r.startDate)} — ${fmtDate(r.endDate)} · <strong>${r.workDays||0} day(s)</strong></div>
      ${r.notes?`<div class="ac-notes">${r.notes}</div>`:""}
      ${clashCount>0?`<div class="ac-clash ${clashCount>=4?"clash-danger":"clash-warn"}">
        ⚠️ ${clashCount} colleague(s) from ${r.groupId} have overlapping leave:
        ${clashers.map(x=>x.employeeName).join(", ")}
      </div>`:""}
      ${isEditReq?`<div class="ac-edit-req">✏️ Staff has requested to edit this approved leave.</div>`:""}
      <div class="ac-trail">${renderApprovalTrail(r)}</div>
      <div class="ac-actions">
        ${needsMyApproval(r)?`
          <button class="btn-approve" onclick="approveReq('${r.id}')">Approve</button>
          <button class="btn-reject" onclick="openRejectModal('${r.id}')">Reject</button>`:""}
        ${isEditReq?`
          <button class="btn-approve" onclick="allowEdit('${r.id}')">Allow Edit</button>
          <button class="btn-reject"  onclick="denyEdit('${r.id}')">Deny Edit</button>`:""}
      </div>
    </div>`;
  }).join("");
}

function canApproveEdit(r) {
  const chain = r.approvalChain || [];
  if (!chain.length) return false;
  const firstRole = chain[0];
  if (MGR.role !== firstRole) return false;
  if (["officer","supervisor"].includes(MGR.role) && MGR.groupId && r.groupId!==MGR.groupId) return false;
  return true;
}

function renderApprovalTrail(r) {
  const chain    = r.approvalChain || [];
  const approvals= r.approvals || {};
  const level    = r.currentLevel || 0;
  return `<div class="trail">${chain.map((role,i)=>{
    const a = approvals[i];
    const cls = a ? (a.status==="approved"?"trail-approved":"trail-rejected") : i===level?"trail-current":"trail-pending";
    return `<div class="trail-step ${cls}">
      <div class="trail-dot"></div>
      <div class="trail-info">
        <div class="trail-role">${ROLES[role]||role}</div>
        ${a?`<div class="trail-by">${a.by||""} · ${a.status}</div>`:""}
      </div>
    </div>`;
  }).join("")}</div>`;
}

window.approveReq = async (reqId) => {
  const r = allRequests.find(x=>x.id===reqId);
  if (!r) return;

  // Clash warning
  const clashCount = allRequests.filter(x=>
    x.id!==reqId&&x.groupId===r.groupId&&!["Rejected","Cancelled"].includes(x.status)&&
    !(x.endDate<r.startDate||x.startDate>r.endDate)
  ).length;
  if (clashCount>=4 && !confirm(`⚠️ ${clashCount} others from ${r.groupId} are on leave during this period. Approve anyway?`)) return;

  const chain    = r.approvalChain || [];
  const level    = r.currentLevel  || 0;
  const approvals= { ...(r.approvals||{}) };
  approvals[level] = { status:"approved", by:MGR.name, at: new Date().toISOString() };

  const newLevel  = level + 1;
  const isFullyApproved = newLevel >= chain.length;

  let newStatus = "Pending";
  if (isFullyApproved) {
    newStatus = "Approved";
    // Deduct from balance
    const emp = employees.find(e=>e.id===r.employeeId);
    if (emp && r.leaveType==="Annual Leave") {
      await updateDoc(doc(db,"employees",r.employeeId),{ leaveUsed:(emp.leaveUsed||0)+(r.workDays||0) });
    }
  } else {
    const nextRole = chain[newLevel];
    newStatus = `Approved (${ROLES[nextRole]||nextRole})`;
    // Notify next approver
    await notifyNextApprover(r, newLevel, chain);
  }

  await updateDoc(doc(db,"leaveRequests",reqId),{
    approvals, currentLevel:newLevel, status:newStatus
  });

  // Notify staff
  const emp = employees.find(e=>e.id===r.employeeId);
  if (emp?.email) {
    sendEmail(emp.email,
      `Leave Request Update — ${newStatus}`,
      `Hi ${r.employeeName},\n\nYour leave request has been updated.\n\nStatus: ${newStatus}\nApproved by: ${MGR.name} (${ROLES[MGR.role]})\nType: ${r.leaveType}\nFrom: ${fmtDate(r.startDate)}\nTo: ${fmtDate(r.endDate)}\nDays: ${r.workDays||0}\n\n${isFullyApproved?"Your leave is now fully approved. ✅":"Your request is progressing through the approval chain."}\n\nAES Fire & Rescue — Leave Management System`
    );
  }

  toast(`✅ ${isFullyApproved?"Fully approved":"Approved — forwarded to next level"}`);
};

async function notifyNextApprover(r, nextLevel, chain) {
  const nextRole = chain[nextLevel];
  try {
    let empQ;
    if (["officer","supervisor"].includes(nextRole)) {
      empQ = await getDocs(query(collection(db,"employees"), where("groupId","==",r.groupId), where("role","==",nextRole)));
    } else {
      empQ = await getDocs(query(collection(db,"employees"), where("role","==",nextRole)));
    }
    const emails = empQ.docs.map(d=>d.data().email).filter(Boolean);
    for (const email of emails) {
      await sendEmail(email,
        `Leave Request Awaiting Your Approval — ${r.employeeName}`,
        `A leave request has been forwarded to you for approval.\n\nEmployee: ${r.employeeName}\nGroup: ${r.groupId||""}\nType: ${r.leaveType}\nFrom: ${fmtDate(r.startDate)}\nTo: ${fmtDate(r.endDate)}\nDays: ${r.workDays||0}\n\nPlease log in to the system to review:\nhttps://aes-leave-system.web.app`
      );
    }
  } catch(err) { console.warn("Notify next approver failed:", err); }
}

window.openRejectModal = (reqId) => {
  document.getElementById("rejectReqId").value   = reqId;
  document.getElementById("rejectReason").value  = "";
  document.getElementById("rejectModal").style.display = "flex";
};

document.getElementById("rejectForm").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const reqId  = document.getElementById("rejectReqId").value;
  const reason = document.getElementById("rejectReason").value.trim();
  if (!reason) { toast("Please provide a reason.","error"); return; }

  const r = allRequests.find(x=>x.id===reqId);
  const chain    = r?.approvalChain||[];
  const level    = r?.currentLevel||0;
  const approvals= { ...(r?.approvals||{}) };
  approvals[level] = { status:"rejected", by:MGR.name, at:new Date().toISOString() };

  await updateDoc(doc(db,"leaveRequests",reqId),{
    approvals, status:"Rejected", rejectionReason:reason
  });
  document.getElementById("rejectModal").style.display="none";
  toast("Request rejected.");

  // Notify staff
  const emp = employees.find(e=>e.id===r?.employeeId);
  if (emp?.email) {
    sendEmail(emp.email,
      "Leave Request Rejected",
      `Hi ${r.employeeName},\n\nYour leave request has been rejected.\n\nType: ${r.leaveType}\nFrom: ${fmtDate(r.startDate)}\nTo: ${fmtDate(r.endDate)}\nRejected by: ${MGR.name} (${ROLES[MGR.role]})\nReason: ${reason}\n\nPlease contact your approving officer for more information.\n\nAES Fire & Rescue — Leave Management System`
    );
  }
});

window.allowEdit = async (reqId) => {
  const r = allRequests.find(x=>x.id===reqId);
  await updateDoc(doc(db,"leaveRequests",reqId), { status:"EditAllowed", editRequested:false });
  toast("✅ Edit approved — staff can now edit.");
  const emp = employees.find(e=>e.id===r?.employeeId);
  if (emp?.email) sendEmail(emp.email,"Edit Request Approved",`Hi ${r.employeeName},\n\nYour request to edit your leave has been approved. Please log in and update your request from the History tab.\n\nhttps://aes-leave-system.web.app`);
};

window.denyEdit = async (reqId) => {
  const r = allRequests.find(x=>x.id===reqId);
  await updateDoc(doc(db,"leaveRequests",reqId), { editRequested:false });
  toast("Edit request denied.");
  const emp = employees.find(e=>e.id===r?.employeeId);
  if (emp?.email) sendEmail(emp.email,"Edit Request Denied",`Hi ${r.employeeName},\n\nYour request to edit your approved leave has been denied. Please contact your officer for more information.`);
};

["rejectModalClose","rejectModalCancel"].forEach(id=>
  document.getElementById(id)?.addEventListener("click",()=>document.getElementById("rejectModal").style.display="none")
);

// ── Clashes ───────────────────────────────────────────────────────
function renderClashes() {
  const today  = todayStr();
  const in60   = new Date(); in60.setDate(in60.getDate()+60);
  const in60s  = in60.toISOString().split("T")[0];

  // Today per shift
  const todayEl = document.getElementById("clashToday");
  if (todayEl) {
    todayEl.innerHTML = SHIFT_GROUPS.map(g=>{
      const onL = allRequests.filter(r=>r.status==="Approved"&&r.groupId===g&&r.startDate<=today&&r.endDate>=today);
      const cls = onL.length>=4?"scard-danger":onL.length>=3?"scard-warn":"";
      return `<div class="scard ${cls}">
        <div class="scard-name">${g}</div>
        <div class="scard-count">${onL.length}</div>
        <div class="scard-label">on leave</div>
        <div class="scard-names">${onL.map(r=>r.employeeName).join(", ")||"None"}</div>
      </div>`;
    }).join("");
  }

  // Upcoming overlaps
  const upcoming = allRequests.filter(r=>!["Rejected","Cancelled"].includes(r.status)&&r.endDate>=today&&r.startDate<=in60s);
  const clashes = [];
  SHIFT_GROUPS.forEach(g=>{
    const gReqs = upcoming.filter(r=>r.groupId===g);
    gReqs.forEach(r=>{
      const overlapping = gReqs.filter(x=>x.id!==r.id&&!(x.endDate<r.startDate||x.startDate>r.endDate));
      if (overlapping.length>=3) {
        const key=`${g}-${r.startDate}`;
        if (!clashes.find(c=>c.key===key)) {
          clashes.push({key,group:g,count:overlapping.length+1,start:r.startDate,end:r.endDate,
            names:[r.employeeName,...overlapping.map(x=>x.employeeName)].filter((v,i,a)=>a.indexOf(v)===i)});
        }
      }
    });
  });

  const clashEl = document.getElementById("clashUpcoming");
  if (clashEl) {
    clashEl.innerHTML = clashes.length
      ? clashes.map(c=>`<div class="clash-row ${c.count>=4?"clash-danger":"clash-warn"}">
          <div class="clash-top"><span class="clash-group">${c.group}</span> <span>${c.count} staff overlapping</span> <span class="clash-dates">${fmtDate(c.start)} — ${fmtDate(c.end)}</span></div>
          <div class="clash-names">${c.names.join(", ")}</div>
        </div>`).join("")
      : `<div class="empty-state">✅ No overlapping leave detected in the next 60 days.</div>`;
  }
}

// ── All Leave ─────────────────────────────────────────────────────
function renderAllLeave() {
  const filter = document.getElementById("leaveFilter")?.value||"all";
  const search = (document.getElementById("leaveSearch")?.value||"").toLowerCase();
  const grp    = document.getElementById("leaveGroupFilter")?.value||"all";
  let list     = [...allRequests];
  if (filter!=="all") list=list.filter(r=>r.status===filter);
  if (search)         list=list.filter(r=>r.employeeName?.toLowerCase().includes(search));
  if (grp!=="all")    list=list.filter(r=>r.groupId===grp);

  const el=document.getElementById("allLeaveTable");
  if (!list.length) { el.innerHTML=`<div class="empty-state">No records found.</div>`; return; }

  el.innerHTML=`<table class="data-table">
    <thead><tr>
      <th>Employee</th><th>Group</th><th>Type</th><th>Start</th><th>End</th><th>Days</th><th>Status</th>
    </tr></thead>
    <tbody>${list.map(r=>`<tr>
      <td>${r.employeeName||"--"}</td>
      <td><span class="grp-tag">${r.groupId||"--"}</span></td>
      <td>${r.leaveType||"--"}</td>
      <td>${fmtDate(r.startDate)}</td>
      <td>${fmtDate(r.endDate)}</td>
      <td><strong>${r.workDays||0}</strong></td>
      <td>${statusBadge(r.status)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

// Export to CSV
window.exportLeave = () => {
  const filter = document.getElementById("leaveFilter")?.value||"all";
  let list = [...allRequests];
  if (filter!=="all") list=list.filter(r=>r.status===filter);
  const rows = [["Employee","Group","Leave Type","Start","End","Days","Status"]];
  list.forEach(r=>rows.push([r.employeeName||"",r.groupId||"",r.leaveType||"",r.startDate||"",r.endDate||"",r.workDays||0,r.status||""]));
  const csv = rows.map(r=>r.map(c=>`"${c}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = "data:text/csv;charset=utf-8,"+encodeURIComponent(csv);
  a.download = `AES_Leave_Export_${todayStr()}.csv`;
  a.click();
  toast("✅ Exported successfully.");
};

// ── Employees ─────────────────────────────────────────────────────
function renderEmployees() {
  // Officers/Supervisors can only see their group
  const canManage = ["fire_admin","section_head","director"].includes(MGR.role);
  const search  = (document.getElementById("empSearch")?.value||"").toLowerCase();
  const grpF    = document.getElementById("empGroupFilter")?.value||"all";

  let list = [...employees];
  if (!canManage && MGR.groupId) list = list.filter(e=>e.groupId===MGR.groupId);
  if (search)   list = list.filter(e=>e.name?.toLowerCase().includes(search)||e.email?.toLowerCase().includes(search));
  if (grpF!=="all") list = list.filter(e=>e.groupId===grpF);

  const el=document.getElementById("empList");
  if (!list.length) { el.innerHTML=`<div class="empty-state">No employees found.</div>`; return; }

  el.innerHTML=list.map(emp=>{
    const { start, end } = getCurrentCycle(emp.joinDate);
    const used = allRequests.filter(r=>r.employeeId===emp.id&&r.leaveType==="Annual Leave"&&r.status==="Approved"&&r.startDate>=start&&r.startDate<=end).reduce((s,r)=>s+(r.workDays||0),0);
    const dExp = daysUntilExpiry(emp.joinDate);
    const expWarn = dExp!==null&&dExp<=30&&dExp>=0 ? `<span class="exp-warn">Expires in ${dExp}d</span>` : "";
    return `<div class="emp-card">
      <div class="emp-avatar">${initials(emp.name)}</div>
      <div class="emp-info">
        <div class="emp-name">${emp.name}</div>
        <div class="emp-meta">${emp.groupId||""} · ${roleBadge(emp.role)} ${expWarn}</div>
        <div class="emp-balance">${pbar(used,emp.entitlement)} <span class="emp-days">${used}/${emp.entitlement||0} days · ${(emp.entitlement||0)-used} remaining</span></div>
      </div>
      ${canManage?`<div class="emp-actions">
        <button class="btn-outline-sm" onclick="openEditEmp('${emp.id}')">Edit</button>
        <button class="btn-outline-sm btn-renew" onclick="renewEntitlement('${emp.id}','${emp.name}')">Renew</button>
        <button class="btn-ghost-sm btn-del" onclick="deleteEmp('${emp.id}','${emp.name}')">Remove</button>
      </div>`:""}
    </div>`;
  }).join("");
}

// ── Entitlement renewal ───────────────────────────────────────────
window.renewEntitlement = async (empId, name) => {
  if (!confirm(`Renew leave entitlement for ${name}? This resets their used days to 0 for the new cycle.`)) return;
  try {
    await updateDoc(doc(db,"employees",empId),{ leaveUsed:0, lastRenewal:todayStr() });
    toast(`✅ ${name}'s entitlement renewed.`);
    const emp = employees.find(e=>e.id===empId);
    if (emp?.email) sendEmail(emp.email,"Leave Entitlement Renewed",`Hi ${name},\n\nYour annual leave entitlement has been renewed for the new cycle. You now have ${emp.entitlement||0} days available.\n\nAES Fire & Rescue — Leave Management System`);
  } catch(err) { toast("Error: "+err.message,"error"); }
};

// ── Employee form ─────────────────────────────────────────────────
function populateGroupDD(selected) {
  document.getElementById("efGroup").innerHTML =
    `<option value="">No Group</option>` +
    ALL_GROUPS.map(g=>`<option value="${g}"${g===selected?" selected":""}>${g}</option>`).join("");
}

function openEmpModal(title) {
  document.getElementById("empModalTitle").textContent = title;
  document.getElementById("empFormError").textContent  = "";
  document.getElementById("empFormSubmit").textContent = editingEmpId?"Save Changes":"Add Employee";
  document.getElementById("empModal").style.display    = "flex";
}

window.openEditEmp = (empId) => {
  const emp = employees.find(e=>e.id===empId);
  if (!emp) return;
  editingEmpId=empId;
  document.getElementById("efName").value        = emp.name||"";
  document.getElementById("efEmail").value       = emp.email||"";
  document.getElementById("efEmail").disabled    = true;
  document.getElementById("efPassword").value    = "";
  document.getElementById("efRole").value        = emp.role||"staff";
  document.getElementById("efDept").value        = emp.dept||"DO";
  document.getElementById("efPattern").value     = emp.pattern||"2D2N2O";
  document.getElementById("efRosterStart").value = emp.rosterStart||"";
  document.getElementById("efJoinDate").value    = emp.joinDate||"";
  document.getElementById("efEntitlement").value = emp.entitlement||"";
  populateGroupDD(emp.groupId);
  openEmpModal("Edit Employee");
};

document.getElementById("addEmpBtn")?.addEventListener("click",()=>{
  editingEmpId=null;
  document.getElementById("empForm").reset();
  document.getElementById("efEmail").disabled=false;
  populateGroupDD(null);
  openEmpModal("Add Employee");
});

document.getElementById("empForm").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const errEl=document.getElementById("empFormError");
  const btnEl=document.getElementById("empFormSubmit");
  errEl.textContent=""; btnEl.disabled=true; btnEl.textContent="Saving…";

  const name       = document.getElementById("efName").value.trim();
  const email      = document.getElementById("efEmail").value.trim().toLowerCase();
  const password   = document.getElementById("efPassword").value;
  const role       = document.getElementById("efRole").value;
  const dept       = document.getElementById("efDept").value;
  const pattern    = document.getElementById("efPattern").value.trim()||"2D2N2O";
  const rosterStart= document.getElementById("efRosterStart").value;
  const joinDate   = document.getElementById("efJoinDate").value;
  const entitlement= parseInt(document.getElementById("efEntitlement").value);
  const groupId    = document.getElementById("efGroup").value||null;

  if (!name||!email||!joinDate||!entitlement||isNaN(entitlement)) {
    errEl.textContent="Please fill all required fields.";
    btnEl.disabled=false; btnEl.textContent=editingEmpId?"Save Changes":"Add Employee"; return;
  }
  if (!editingEmpId&&!password) {
    errEl.textContent="Password required."; btnEl.disabled=false; btnEl.textContent="Add Employee"; return;
  }
  if (!editingEmpId&&password.length<6) {
    errEl.textContent="Password min 6 chars."; btnEl.disabled=false; btnEl.textContent="Add Employee"; return;
  }

  try {
    if (!editingEmpId) {
      const sa   = getSecondaryAuth();
      const cred = await createUserWithEmailAndPassword(sa,email,password);
      const uid  = cred.user.uid;
      await sa.signOut();
      const b = writeBatch(db);
      b.set(doc(db,"users",uid),{name,email,role,dept,createdAt:serverTimestamp()});
      b.set(doc(db,"employees",uid),{name,email,dept,pattern,rosterStart:rosterStart||null,joinDate,entitlement,leaveUsed:0,groupId,role,createdAt:serverTimestamp()});
      await b.commit();
      toast(`✅ ${name} added.`);
    } else {
      const b=writeBatch(db);
      b.update(doc(db,"employees",editingEmpId),{name,dept,pattern,rosterStart:rosterStart||null,joinDate,entitlement,groupId,role});
      b.update(doc(db,"users",editingEmpId),{name,role,dept});
      await b.commit();
      toast(`✅ ${name} updated.`);
    }
    document.getElementById("empModal").style.display="none";
    document.getElementById("efEmail").disabled=false;
    editingEmpId=null;
  } catch(err) {
    if (err.code==="auth/email-already-in-use") errEl.textContent="❌ Email already registered.";
    else if (err.code==="auth/invalid-email")   errEl.textContent="❌ Invalid email.";
    else errEl.textContent="❌ "+err.message;
  } finally {
    btnEl.disabled=false; btnEl.textContent=editingEmpId?"Save Changes":"Add Employee";
  }
});

window.deleteEmp = async(empId,name)=>{
  if (!confirm(`Remove ${name}?`)) return;
  await updateDoc(doc(db,"employees",empId),{deleted:true,deletedAt:serverTimestamp()});
  toast(`${name} removed.`);
};

["empModalClose","empModalCancel"].forEach(id=>
  document.getElementById(id)?.addEventListener("click",()=>{
    document.getElementById("empModal").style.display="none";
    document.getElementById("efEmail").disabled=false;
    editingEmpId=null;
  })
);

// ── My Leave ──────────────────────────────────────────────────────
function renderMyLeaveOverview() {
  if (!myOwnEmp) return;
  const { start, end } = getCurrentCycle(myOwnEmp.joinDate);
  const ent = myOwnEmp.entitlement||0;
  const used = myOwnRequests.filter(r=>r.leaveType==="Annual Leave"&&r.status==="Approved"&&r.startDate>=start&&r.startDate<=end).reduce((s,r)=>s+(r.workDays||0),0);
  const rem  = Math.max(0,ent-used);
  const pct  = ent?Math.min(100,Math.round(used/ent*100)):0;
  const dExp = daysUntilExpiry(myOwnEmp.joinDate);

  document.getElementById("myOvEntitlement").textContent = ent;
  document.getElementById("myOvUsed").textContent        = used;
  document.getElementById("myOvRemaining").textContent   = rem;
  document.getElementById("myOvExpiry").textContent      = dExp!==null?`${dExp} days until renewal`:"--";
  document.getElementById("myOvBar").style.width         = pct+"%";
  document.getElementById("myOvBarPct").textContent      = pct+"%";
  document.getElementById("myOvCycle").textContent       = `${fmtDate(start)} — ${fmtDate(end)}`;
}

function renderMyLeaveHistory() {
  const el=document.getElementById("myLeaveList");
  if (!myOwnRequests.length) { el.innerHTML=`<div class="empty-state">No requests yet.</div>`; return; }
  el.innerHTML=myOwnRequests.map(r=>`
    <div class="req-card">
      <div class="req-card-head">
        <div>
          <div class="req-type">${r.leaveType}</div>
          <div class="req-dates">${fmtDate(r.startDate)} — ${fmtDate(r.endDate)} · <strong>${r.workDays||0} day(s)</strong></div>
        </div>
        ${statusBadge(r.status)}
      </div>
      ${r.notes?`<div class="req-notes">${r.notes}</div>`:""}
    </div>`).join("");
}

document.getElementById("myLeaveForm")?.addEventListener("submit", async(e)=>{
  e.preventDefault();
  if (!myOwnEmp) { toast("No employee record. Ask admin to add you as an employee.","error"); return; }
  const errEl=document.getElementById("myLeaveError");
  const btn=e.target.querySelector("button[type=submit]");
  errEl.textContent=""; btn.disabled=true; btn.textContent="Submitting…";
  const start=document.getElementById("myStart").value;
  const end=document.getElementById("myEnd").value;
  const type=document.getElementById("myType").value;
  const notes=document.getElementById("myNotes").value.trim();
  if (!start||!end||end<start){errEl.textContent="Invalid dates.";btn.disabled=false;btn.textContent="Submit";return;}
  const days=countLeaveDays(start,end);
  if (days===0){errEl.textContent="No working days in range.";btn.disabled=false;btn.textContent="Submit";return;}
  const chain=getApprovalChain(myOwnEmp.groupId,MGR.role);
  try {
    await addDoc(collection(db,"leaveRequests"),{
      employeeId:MGR.uid,employeeName:myOwnEmp.name||MGR.name,
      groupId:myOwnEmp.groupId||null,dept:myOwnEmp.dept||"GD",
      leaveType:type,startDate:start,endDate:end,workDays:days,notes,
      status:"Pending",approvalChain:chain,approvals:{},currentLevel:0,
      editRequested:false,createdAt:serverTimestamp()
    });
    toast("✅ Leave request submitted.");
    e.target.reset();
    renderMyLeaveHistory();
  } catch(err){errEl.textContent="Failed: "+err.message;}
  finally{btn.disabled=false;btn.textContent="Submit";}
});

// ── Change password ───────────────────────────────────────────────
["changePwBtn","mobileCpBtn"].forEach(id=>{
  document.getElementById(id)?.addEventListener("click",()=>{
    document.getElementById("cpForm").reset();
    document.getElementById("cpErr").textContent="";
    document.getElementById("cpOk").textContent="";
    document.getElementById("cpModal").style.display="flex";
  });
});
["cpModalClose","cpModalCancel"].forEach(id=>
  document.getElementById(id)?.addEventListener("click",()=>document.getElementById("cpModal").style.display="none")
);
document.getElementById("cpForm").addEventListener("submit",async(e)=>{
  e.preventDefault();
  const errEl=document.getElementById("cpErr"),okEl=document.getElementById("cpOk");
  errEl.textContent="";okEl.textContent="";
  const cur=document.getElementById("cpCurrent").value;
  const nw=document.getElementById("cpNew").value;
  const cf=document.getElementById("cpConfirm").value;
  if(nw.length<6){errEl.textContent="Min 6 characters.";return;}
  if(nw!==cf){errEl.textContent="Passwords don't match.";return;}
  try{
    const user=auth.currentUser;
    const cred=EmailAuthProvider.credential(user.email,cur);
    await reauthenticateWithCredential(user,cred);
    await updatePassword(user,nw);
    okEl.textContent="✅ Password updated.";
    document.getElementById("cpForm").reset();
  }catch(err){
    errEl.textContent=err.code==="auth/wrong-password"||err.code==="auth/invalid-credential"
      ?"Current password incorrect.":"Error: "+err.message;
  }
});

// ── UI Setup & Nav ────────────────────────────────────────────────
function setupUI() {
  const canManage = ["fire_admin","section_head","director"].includes(MGR.role);

  // Hide add/remove for officers
  if (!canManage) {
    document.getElementById("addEmpBtn")?.style && (document.getElementById("addEmpBtn").style.display="none");
  }

  // Populate filters
  const gf=document.getElementById("empGroupFilter");
  if (gf) gf.innerHTML=`<option value="all">All Groups</option>`+ALL_GROUPS.map(g=>`<option value="${g}">${g}</option>`).join("");

  const lgf=document.getElementById("leaveGroupFilter");
  if (lgf) lgf.innerHTML=`<option value="all">All Groups</option>`+ALL_GROUPS.map(g=>`<option value="${g}">${g}</option>`).join("");

  // Sidebar nav
  document.querySelectorAll(".snav-item").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.querySelectorAll(".snav-item").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      showMgrSection(btn.dataset.sec);
    });
  });

  // Mobile nav
  document.querySelectorAll(".mbnav-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.querySelectorAll(".mbnav-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      showMgrSection(btn.dataset.sec);
    });
  });

  // Logout
  ["logoutBtn","mobileLogoutBtn"].forEach(id=>{
    document.getElementById(id)?.addEventListener("click",()=>signOut(auth).then(()=>window.location.href="../index.html"));
  });

  // Filters
  document.getElementById("leaveFilter")?.addEventListener("change",renderAllLeave);
  document.getElementById("leaveSearch")?.addEventListener("input",renderAllLeave);
  document.getElementById("leaveGroupFilter")?.addEventListener("change",renderAllLeave);
  document.getElementById("empSearch")?.addEventListener("input",renderEmployees);
  document.getElementById("empGroupFilter")?.addEventListener("change",renderEmployees);

  showMgrSection("dashboard");
}

function showMgrSection(id) {
  document.querySelectorAll(".mgr-section").forEach(s=>s.classList.remove("active"));
  document.querySelectorAll(".snav-item,.mbnav-btn").forEach(b=>b.classList.remove("active"));
  document.getElementById("sec-"+id)?.classList.add("active");
  document.querySelectorAll(`[data-sec="${id}"]`).forEach(b=>b.classList.add("active"));
}
window.showMgrSection = showMgrSection;
