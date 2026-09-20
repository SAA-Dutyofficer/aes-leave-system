// js/roster.js — AES Fire & Rescue Roster Management
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
         onSnapshot, serverTimestamp, query, orderBy, where, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { fmtDate, todayStr, ROLES, ALL_GROUPS, SHIFT_GROUPS, GD_SECTIONS,
         toast, statusBadge, getApprovalChain, APPROVER_ROLES } from "./utils.js";
import { sendEmail } from "./email.js";

// ── Constants ──────────────────────────────────────────────────────
const SHIFT_PATTERNS = {
  "2D2N2O":  { label:"2D2N2O (Current)",      cycle:6,  days:["D","D","N","N","O","O"] },
  "48H4O":   { label:"48H4O (48hrs + 4 off)", cycle:6,  days:["48","48","O","O","O","O"], merged:true },
  "3W3O":    { label:"3W3O (3 on 3 off)",     cycle:6,  days:["W","W","W","O","O","O"] },
  "4W3O":    { label:"4W3O (4 on 3 off)",     cycle:7,  days:["W","W","W","W","O","O","O"] },
  "4W4O":    { label:"4W4O (4 on 4 off)",     cycle:8,  days:["W","W","W","W","O","O","O","O"] },
  "5W2O":    { label:"5W2O (Mon–Fri)",         cycle:7,  days:["W","W","W","W","W","O","O"] },
  "GD":      { label:"GD (Mon–Thu)",           cycle:7,  days:["W","W","W","W","O","O","O"], gdMode:true },
};

const DAY_LABELS = { D:"D", N:"N", "48":"48H", W:"W", O:"O" };
const DAY_CLASSES = {
  D:   "rd-day",
  N:   "rd-night",
  "48":"rd-48h",
  W:   "rd-work",
  O:   "rd-off",
  AL:  "rd-leave",   // Approved leave
  SL:  "rd-leave",
  EL:  "rd-leave",
  HL:  "rd-holiday",
  SWAP:"rd-swap",
};

let MGR = {}, employees = [], rosterData = {}, approvedLeave = [], swapRequests = [];
let currentYear, currentMonth, viewMode = "all", selectedGroup = "all";

// ── Auth ───────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "../index.html"; return; }
  try {
    const snap = await getDoc(doc(db,"users",user.uid));
    if (!snap.exists()) { window.location.href="../index.html"; return; }
    const data = snap.data();
    if (!APPROVER_ROLES.includes(data.role)) { window.location.href="../index.html"; return; }
    MGR = { uid:user.uid, ...data, isSuperAdmin: data.role==="superadmin" };

    const canBuild = ["fire_admin","section_head","director","superadmin"].includes(MGR.role);

    document.getElementById("rosterNavName").textContent = MGR.name || user.email;
    document.getElementById("rosterNavRole").textContent = ROLES[MGR.role] || MGR.role;
    document.getElementById("rosterInitials").textContent = initials(MGR.name);

    if (!canBuild) {
      document.getElementById("buildControls").style.display = "none";
      document.getElementById("groupSetupBtn").style.display = "none";
    }

    initNav();
    loadData();

    const now = new Date();
    currentYear  = now.getFullYear();
    currentMonth = now.getMonth();
    renderRoster();
  } catch(err) { console.error("Roster auth:", err); }
});

function initials(name) {
  if (!name) return "?";
  return name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
}

// ── Data ───────────────────────────────────────────────────────────
function loadData() {
  // Employees
  onSnapshot(query(collection(db,"employees"), orderBy("name")), snap => {
    employees = snap.docs.map(d=>({id:d.id,...d.data()})).filter(e=>!e.deleted);
    renderRoster();
    populateGroupFilter();
    renderSwapRequests();
  });

  // Approved leave
  onSnapshot(collection(db,"leaveRequests"), snap => {
    approvedLeave = snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.status==="Approved");
    renderRoster();
  });

  // Roster data (stored as rosterData/{year-month}/{empId})
  const key = rosterKey(currentYear, currentMonth);
  onSnapshot(collection(db,`rosterData/${key}/entries`), snap => {
    rosterData[key] = {};
    snap.docs.forEach(d => { rosterData[key][d.id] = d.data(); });
    renderRoster();
  });

  // Swap requests
  onSnapshot(query(collection(db,"swapRequests"), orderBy("createdAt","desc")), snap => {
    swapRequests = snap.docs.map(d=>({id:d.id,...d.data()}));
    renderSwapRequests();
  });
}

function rosterKey(y, m) {
  return `${y}-${String(m+1).padStart(2,"0")}`;
}

// ── Main Roster Render ─────────────────────────────────────────────
function renderRoster() {
  const el = document.getElementById("rosterGrid");
  if (!el) return;

  const key   = rosterKey(currentYear, currentMonth);
  const first = new Date(currentYear, currentMonth, 1);
  const last  = new Date(currentYear, currentMonth+1, 0);
  const days  = last.getDate();

  // Update month label
  document.getElementById("rosterMonthLabel").textContent =
    first.toLocaleDateString("en-GB",{month:"long",year:"numeric"});

  // Filter employees
  let emps = [...employees];
  if (selectedGroup !== "all") emps = emps.filter(e=>e.groupId===selectedGroup);

  if (!emps.length) {
    el.innerHTML = `<div class="empty-state">No employees found for this view.</div>`;
    return;
  }

  // Build date headers
  const dateHeaders = [];
  for (let d=1; d<=days; d++) {
    const ds  = `${currentYear}-${String(currentMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const wd  = new Date(ds+"T00:00:00").getDay();
    const wdLabel = ["Su","Mo","Tu","We","Th","Fr","Sa"][wd];
    const isWeekend = wd===0||wd===5||wd===6;
    dateHeaders.push({ d, ds, wd, wdLabel, isWeekend });
  }

  // Build table
  let html = `<div class="roster-table-wrap"><table class="roster-table">
    <thead>
      <tr>
        <th class="roster-name-col">Employee</th>
        <th class="roster-group-col">Group</th>
        ${dateHeaders.map(h=>`<th class="roster-day-hdr ${h.isWeekend?"rd-weekend-hdr":""}">${h.d}<br/><span class="roster-wd">${h.wdLabel}</span></th>`).join("")}
      </tr>
    </thead>
    <tbody>`;

  // Group employees for display
  const groups = [...new Set(emps.map(e=>e.groupId||"Unassigned"))];
  groups.forEach(grp => {
    const grpEmps = emps.filter(e=>(e.groupId||"Unassigned")===grp);
    // Group header row
    html += `<tr class="roster-group-row"><td colspan="${days+2}" class="roster-group-hdr">${grp}</td></tr>`;

    grpEmps.forEach(emp => {
      const empRoster = rosterData[key]?.[emp.id] || {};
      html += `<tr class="roster-emp-row" data-empid="${emp.id}">
        <td class="roster-name-cell">
          <div class="roster-emp-name">${emp.name}</div>
        </td>
        <td class="roster-group-cell"><span class="grp-tag-sm">${emp.groupId||"--"}</span></td>`;

      dateHeaders.forEach(({ d, ds, isWeekend }) => {
        const cell = getCellData(emp, ds, d, empRoster, isWeekend);
        const canEdit = ["fire_admin","section_head","director","superadmin"].includes(MGR.role);
        html += `<td class="roster-cell ${cell.cls} ${isWeekend?"rd-weekend":""}"
          ${canEdit?`onclick="openCellEditor('${emp.id}','${ds}','${emp.name}','${cell.type}')"`:""} 
          title="${emp.name} · ${ds}">
          <span class="roster-cell-label">${cell.label}</span>
        </td>`;
      });

      html += `</tr>`;
    });
  });

  html += `</tbody></table></div>`;
  el.innerHTML = html;
}

function getCellData(emp, ds, dayNum, empRoster, isWeekend) {
  // 1. Check approved leave first
  const onLeave = approvedLeave.find(r=>r.employeeId===emp.id && r.startDate<=ds && r.endDate>=ds);
  if (onLeave) return { type:"AL", label:"AL", cls:"rd-leave" };

  // 2. Check manual roster entry
  if (empRoster[ds]) {
    const t = empRoster[ds].type;
    return { type:t, label:DAY_LABELS[t]||t, cls:DAY_CLASSES[t]||"rd-work" };
  }

  // 3. Auto-calculate from pattern
  const pattern = emp.pattern || "GD";
  const rosterStart = emp.rosterStart;

  if (pattern==="GD" || emp.dept==="GD") {
    const wd = new Date(ds+"T00:00:00").getDay();
    const isWork = wd>=1 && wd<=4;
    return isWork ? { type:"W",label:"W",cls:"rd-work" } : { type:"O",label:"O",cls:"rd-off" };
  }

  if (!rosterStart) return { type:"?", label:"?", cls:"rd-unknown" };

  const patDef = SHIFT_PATTERNS[pattern];
  if (!patDef) return { type:"?", label:"?", cls:"rd-unknown" };

  const d = new Date(ds+"T00:00:00");
  const r = new Date(rosterStart+"T00:00:00");
  const diff = Math.round((d-r)/86400000);
  const pos  = ((diff % patDef.cycle) + patDef.cycle) % patDef.cycle;
  const type = patDef.days[pos] || "O";

  return { type, label:DAY_LABELS[type]||type, cls:DAY_CLASSES[type]||"rd-off" };
}

// ── Cell Editor ────────────────────────────────────────────────────
window.openCellEditor = (empId, ds, empName, currentType) => {
  document.getElementById("cellEmpId").value   = empId;
  document.getElementById("cellDate").value    = ds;
  document.getElementById("cellEmpName").textContent = empName;
  document.getElementById("cellDateLabel").textContent = fmtDate(ds);
  document.getElementById("cellType").value    = currentType;
  document.getElementById("cellModal").style.display = "flex";
};

document.getElementById("cellForm")?.addEventListener("submit", async(e)=>{
  e.preventDefault();
  const empId = document.getElementById("cellEmpId").value;
  const ds    = document.getElementById("cellDate").value;
  const type  = document.getElementById("cellType").value;
  const key   = rosterKey(currentYear, currentMonth);
  try {
    const ref = doc(db,`rosterData/${key}/entries`,empId);
    const snap = await getDoc(ref);
    const existing = snap.exists() ? snap.data() : {};
    existing[ds] = { type, updatedBy:MGR.name, updatedAt:new Date().toISOString() };
    await setDoc(ref, existing);
    // Update local cache immediately so roster re-renders without waiting for snapshot
    if (!rosterData[key]) rosterData[key] = {};
    if (!rosterData[key][empId]) rosterData[key][empId] = {};
    rosterData[key][empId][ds] = { type };
    renderRoster();
    toast(`✅ Updated ${fmtDate(ds)}`);
    document.getElementById("cellModal").style.display="none";
  } catch(err) { toast("Error: "+err.message,"error"); }
});

["cellModalClose","cellModalCancel"].forEach(id=>
  document.getElementById(id)?.addEventListener("click",()=>document.getElementById("cellModal").style.display="none")
);

// ── Group Pattern Setup ────────────────────────────────────────────
window.openGroupSetup = () => {
  document.getElementById("groupSetupModal").style.display="flex";
  renderGroupSetupList();
};

function renderGroupSetupList() {
  const el = document.getElementById("groupSetupList");
  el.innerHTML = ALL_GROUPS.map(g=>{
    // Find existing group config
    const grpEmps = employees.filter(e=>e.groupId===g);
    const samplePattern = grpEmps[0]?.pattern || "2D2N2O";
    const sampleStart   = grpEmps[0]?.rosterStart || "";
    return `<div class="group-setup-row">
      <div class="gs-name">${g} <span class="gs-count">(${grpEmps.length} staff)</span></div>
      <div class="gs-fields">
        <select class="gs-pattern" data-group="${g}">
          ${Object.entries(SHIFT_PATTERNS).map(([k,v])=>`<option value="${k}"${k===samplePattern?" selected":""}>${v.label}</option>`).join("")}
        </select>
        <input type="date" class="gs-start" data-group="${g}" value="${sampleStart}" placeholder="Pattern start date"/>
        <button class="btn-primary-sm" onclick="applyGroupPattern('${g}')">Apply</button>
      </div>
    </div>`;
  }).join("");
}

window.applyGroupPattern = async (groupId) => {
  const patternEl = document.querySelector(`.gs-pattern[data-group="${groupId}"]`);
  const startEl   = document.querySelector(`.gs-start[data-group="${groupId}"]`);
  const pattern   = patternEl?.value;
  const start     = startEl?.value;
  if (!pattern||!start) { toast("Please select pattern and start date.","error"); return; }

  const grpEmps = employees.filter(e=>e.groupId===groupId);
  if (!grpEmps.length) { toast("No employees in this group.","warn"); return; }

  const batch = writeBatch(db);
  grpEmps.forEach(emp=>{
    batch.update(doc(db,"employees",emp.id),{ pattern, rosterStart:start });
  });
  await batch.commit();
  toast(`✅ Pattern applied to ${grpEmps.length} staff in ${groupId}`);
  renderRoster();
};

["groupSetupClose","groupSetupCancel"].forEach(id=>
  document.getElementById(id)?.addEventListener("click",()=>document.getElementById("groupSetupModal").style.display="none")
);

// ── Generate Next Month ────────────────────────────────────────────
window.generateNextMonth = async () => {
  const nextM = currentMonth===11 ? 0 : currentMonth+1;
  const nextY = currentMonth===11 ? currentYear+1 : currentYear;
  const nextKey = rosterKey(nextY, nextM);

  if (!confirm(`Generate roster for ${new Date(nextY,nextM,1).toLocaleDateString("en-GB",{month:"long",year:"numeric"})}? This will copy patterns from this month.`)) return;

  // Copy current month's manual overrides to next month as a base
  const curKey = rosterKey(currentYear, currentMonth);
  const curSnap = await getDocs(collection(db,`rosterData/${curKey}/entries`));

  const batch = writeBatch(db);
  // Just confirm the next month exists — patterns auto-calculate
  // Only copy manual overrides that make sense (not leave markers)
  curSnap.docs.forEach(d=>{
    const data = d.data();
    const filtered = {};
    Object.entries(data).forEach(([ds,v])=>{
      // Don't carry over leave entries, only manual shift changes
      if (!["AL","SL","EL"].includes(v.type)) filtered[ds] = v;
    });
    if (Object.keys(filtered).length) {
      batch.set(doc(db,`rosterData/${nextKey}/entries`,d.id), filtered);
    }
  });
  await batch.commit();

  // Switch to next month view
  currentMonth = nextM;
  currentYear  = nextY;

  // Reload next month's data
  onSnapshot(collection(db,`rosterData/${nextKey}/entries`), snap=>{
    rosterData[nextKey]={};
    snap.docs.forEach(d=>{ rosterData[nextKey][d.id]=d.data(); });
    renderRoster();
  });

  toast(`✅ Roster generated for ${new Date(nextY,nextM,1).toLocaleDateString("en-GB",{month:"long",year:"numeric"})}`);
};

// ── Month navigation ───────────────────────────────────────────────
window.rosterPrevMonth = () => {
  if (currentMonth===0) { currentMonth=11; currentYear--; } else currentMonth--;
  reloadRosterMonth();
};
window.rosterNextMonth = () => {
  if (currentMonth===11) { currentMonth=0; currentYear++; } else currentMonth++;
  reloadRosterMonth();
};

function reloadRosterMonth() {
  const key = rosterKey(currentYear, currentMonth);
  if (!rosterData[key]) {
    onSnapshot(collection(db,`rosterData/${key}/entries`), snap=>{
      rosterData[key]={};
      snap.docs.forEach(d=>{ rosterData[key][d.id]=d.data(); });
      renderRoster();
    });
  } else {
    renderRoster();
  }
}

// ── Print & Export ─────────────────────────────────────────────────
window.printRoster = () => window.print();

window.exportRosterCSV = () => {
  const key   = rosterKey(currentYear, currentMonth);
  const first = new Date(currentYear, currentMonth, 1);
  const last  = new Date(currentYear, currentMonth+1, 0);
  const days  = last.getDate();

  const headers = ["Employee","Group",...Array.from({length:days},(_,i)=>`${i+1}`)];
  const rows = [headers];

  let emps = [...employees];
  if (selectedGroup!=="all") emps=emps.filter(e=>e.groupId===selectedGroup);

  emps.forEach(emp=>{
    const empRoster = rosterData[key]?.[emp.id]||{};
    const row = [emp.name, emp.groupId||""];
    for (let d=1;d<=days;d++) {
      const ds=`${currentYear}-${String(currentMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const cell = getCellData(emp,ds,d,empRoster,false);
      row.push(cell.label);
    }
    rows.push(row);
  });

  const csv = rows.map(r=>r.map(c=>`"${c}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);
  a.download=`AES_Roster_${rosterKey(currentYear,currentMonth)}.csv`;
  a.click();
  toast("✅ Roster exported.");
};

// ── Shift Swaps ────────────────────────────────────────────────────
window.openSwapRequest = () => {
  document.getElementById("swapForm").reset();
  document.getElementById("swapError").textContent="";
  populateSwapEmployeeList();
  document.getElementById("swapModal").style.display="flex";
};

function populateSwapEmployeeList() {
  const sel = document.getElementById("swapWithEmp");
  sel.innerHTML = `<option value="">Select employee…</option>` +
    employees.filter(e=>e.id!==MGR.uid).map(e=>`<option value="${e.id}">${e.name} (${e.groupId||""})</option>`).join("");
}

document.getElementById("swapForm")?.addEventListener("submit", async(e)=>{
  e.preventDefault();
  const errEl     = document.getElementById("swapError");
  const myDate    = document.getElementById("swapMyDate").value;
  const theirDate = document.getElementById("swapTheirDate").value;
  const withEmpId = document.getElementById("swapWithEmp").value;
  const notes     = document.getElementById("swapNotes").value.trim();

  if (!myDate||!theirDate||!withEmpId) { errEl.textContent="Please fill all fields."; return; }

  const withEmp = employees.find(e=>e.id===withEmpId);
  const myEmp   = employees.find(e=>e.id===MGR.uid);

  if (!withEmp) { errEl.textContent="Employee not found."; return; }

  try {
    const ref = await addDoc(collection(db,"swapRequests"),{
      requesterId:    MGR.uid,
      requesterName:  myEmp?.name||MGR.name,
      requesteeId:    withEmpId,
      requesteeName:  withEmp.name,
      requesterDate:  myDate,
      requesteeDate:  theirDate,
      notes,
      status:         "Pending Acceptance",
      requesteeAccepted: false,
      approvalChain:  getApprovalChain(myEmp?.groupId||"", MGR.role),
      approvals:      {},
      currentLevel:   0,
      createdAt:      serverTimestamp()
    });

    // Email the other employee
    if (withEmp.email) {
      sendEmail(withEmp.email,
        `Shift Swap Request from ${myEmp?.name||MGR.name}`,
        `Hi ${withEmp.name},\n\n${myEmp?.name||MGR.name} has requested a shift swap with you.\n\nTheir date: ${fmtDate(myDate)}\nYour date: ${fmtDate(theirDate)}\n${notes?"Notes: "+notes+"\n":""}\nPlease log in to review and accept or decline:\nhttps://aes-leave-system.web.app/pages/roster.html`
      );
    }

    toast("✅ Swap request sent.");
    document.getElementById("swapModal").style.display="none";
  } catch(err) { errEl.textContent="Failed: "+err.message; }
});

["swapModalClose","swapModalCancel"].forEach(id=>
  document.getElementById(id)?.addEventListener("click",()=>document.getElementById("swapModal").style.display="none")
);

// ── Swap request rendering ─────────────────────────────────────────
function renderSwapRequests() {
  const el = document.getElementById("swapList");
  if (!el) return;

  // Requests involving me
  const mySwaps = swapRequests.filter(r=>r.requesterId===MGR.uid||r.requesteeId===MGR.uid);
  // Requests needing my approval
  const approvalSwaps = swapRequests.filter(r=>needsSwapApproval(r));

  const all = [...new Map([...mySwaps,...approvalSwaps].map(r=>[r.id,r])).values()];

  if (!all.length) { el.innerHTML=`<div class="empty-state">No swap requests.</div>`; return; }

  el.innerHTML = all.map(r=>`
    <div class="swap-card">
      <div class="swap-head">
        <div>
          <div class="swap-title">${r.requesterName} ↔ ${r.requesteeName}</div>
          <div class="swap-dates">${fmtDate(r.requesterDate)} ↔ ${fmtDate(r.requesteeDate)}</div>
        </div>
        ${statusBadge(r.status)}
      </div>
      ${r.notes?`<div class="swap-notes">${r.notes}</div>`:""}
      <div class="swap-actions">
        ${r.requesteeId===MGR.uid && r.status==="Pending Acceptance"?`
          <button class="btn-approve" onclick="acceptSwap('${r.id}')">Accept</button>
          <button class="btn-reject"  onclick="declineSwap('${r.id}')">Decline</button>`:""}
        ${needsSwapApproval(r)?`
          <button class="btn-approve" onclick="approveSwap('${r.id}')">Approve Swap</button>
          <button class="btn-reject"  onclick="rejectSwap('${r.id}')">Reject Swap</button>`:""}
      </div>
    </div>`).join("");
}

function needsSwapApproval(r) {
  if (!["Accepted - Pending Approval"].includes(r.status)) return false;
  if (MGR.isSuperAdmin) return true;
  const chain = r.approvalChain||[];
  const level = r.currentLevel||0;
  if (level>=chain.length) return false;
  return MGR.role===chain[level];
}

window.acceptSwap = async (swapId) => {
  const r = swapRequests.find(x=>x.id===swapId);
  if (!r) return;
  await updateDoc(doc(db,"swapRequests",swapId),{
    status:"Accepted - Pending Approval", requesteeAccepted:true
  });
  // Notify first approver in chain
  const chain = r.approvalChain||[];
  if (chain.length) {
    const firstRole = chain[0];
    const approvers = employees.filter(e=>e.role===firstRole);
    for (const a of approvers) {
      if (a.email) sendEmail(a.email,
        `Shift Swap Approved by Both Parties — Needs Your Approval`,
        `${r.requesterName} and ${r.requesteeName} have agreed to swap shifts.\n\n${fmtDate(r.requesterDate)} ↔ ${fmtDate(r.requesteeDate)}\n\nPlease log in to approve or reject:\nhttps://aes-leave-system.web.app/pages/roster.html`
      );
    }
  }
  toast("✅ Swap accepted — sent for approval.");
};

window.declineSwap = async (swapId) => {
  const r = swapRequests.find(x=>x.id===swapId);
  await updateDoc(doc(db,"swapRequests",swapId),{ status:"Declined" });
  // Notify requester
  const requester = employees.find(e=>e.id===r?.requesterId);
  if (requester?.email) sendEmail(requester.email,"Shift Swap Declined",`Hi ${r.requesterName},\n\n${r.requesteeName} has declined your shift swap request for ${fmtDate(r.requesterDate)}.\n\nAES Fire & Rescue — Leave Management`);
  toast("Swap declined.");
};

window.approveSwap = async (swapId) => {
  const r = swapRequests.find(x=>x.id===swapId);
  if (!r) return;
  const chain    = r.approvalChain||[];
  const level    = r.currentLevel||0;
  const approvals= {...(r.approvals||{})};
  approvals[level]={ status:"approved", by:MGR.name, at:new Date().toISOString() };
  const newLevel = level+1;
  const isFullyApproved = newLevel>=chain.length;

  if (isFullyApproved) {
    // Apply the swap to the roster
    await applySwapToRoster(r);
    await updateDoc(doc(db,"swapRequests",swapId),{ approvals, currentLevel:newLevel, status:"Approved" });
    // Notify both parties
    const req = employees.find(e=>e.id===r.requesterId);
    const rec = employees.find(e=>e.id===r.requesteeId);
    [req,rec].forEach(emp=>{
      if (emp?.email) sendEmail(emp.email,"Shift Swap Approved ✅",`Your shift swap has been fully approved.\n\n${r.requesterName} ↔ ${r.requesteeName}\n${fmtDate(r.requesterDate)} ↔ ${fmtDate(r.requesteeDate)}\n\nThe roster has been updated.\n\nAES Fire & Rescue — Leave Management`);
    });
    toast("✅ Swap fully approved and roster updated.");
  } else {
    await updateDoc(doc(db,"swapRequests",swapId),{ approvals, currentLevel:newLevel, status:`Approved (Level ${newLevel})` });
    toast("✅ Approved — forwarded to next level.");
  }
};

async function applySwapToRoster(r) {
  const reqEmp = employees.find(e=>e.id===r.requesterId);
  const recEmp = employees.find(e=>e.id===r.requesteeId);

  // Get shift types for each on their respective dates
  const reqKey = rosterKey(new Date(r.requesterDate+"T00:00:00").getFullYear(), new Date(r.requesterDate+"T00:00:00").getMonth());
  const recKey = rosterKey(new Date(r.requesteeDate+"T00:00:00").getFullYear(), new Date(r.requesteeDate+"T00:00:00").getMonth());

  const reqRosterSnap = await getDoc(doc(db,`rosterData/${reqKey}/entries`,r.requesterId));
  const recRosterSnap = await getDoc(doc(db,`rosterData/${recKey}/entries`,r.requesteeId));

  const reqRoster = reqRosterSnap.exists()?reqRosterSnap.data():{};
  const recRoster = recRosterSnap.exists()?recRosterSnap.data():{};

  // Get original shift types
  const reqOrigCell = getCellData(reqEmp,r.requesterDate,0,reqRoster,false);
  const recOrigCell = getCellData(recEmp,r.requesteeDate,0,recRoster,false);

  // Swap them
  reqRoster[r.requesterDate]={ type:recOrigCell.type, swapped:true, swappedWith:r.requesteeName };
  recRoster[r.requesteeDate]={ type:reqOrigCell.type, swapped:true, swappedWith:r.requesterName };

  const batch = writeBatch(db);
  batch.set(doc(db,`rosterData/${reqKey}/entries`,r.requesterId), reqRoster);
  batch.set(doc(db,`rosterData/${recKey}/entries`,r.requesteeId), recRoster);
  await batch.commit();
}

window.rejectSwap = async (swapId) => {
  const r = swapRequests.find(x=>x.id===swapId);
  await updateDoc(doc(db,"swapRequests",swapId),{ status:"Rejected" });
  [r?.requesterId,r?.requesteeId].forEach(async empId=>{
    const emp = employees.find(e=>e.id===empId);
    if (emp?.email) sendEmail(emp.email,"Shift Swap Rejected",`The shift swap between ${r.requesterName} and ${r.requesteeName} has been rejected by ${MGR.name}.\n\nAES Fire & Rescue — Leave Management`);
  });
  toast("Swap rejected.");
};

// ── Filters & Nav ──────────────────────────────────────────────────
function populateGroupFilter() {
  const sel = document.getElementById("rosterGroupFilter");
  if (!sel) return;
  sel.innerHTML = `<option value="all">All Groups</option>` +
    ALL_GROUPS.map(g=>`<option value="${g}">${g}</option>`).join("");
}

function initNav() {
  document.querySelectorAll(".roster-tab-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.querySelectorAll(".roster-tab-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".roster-tab-content").forEach(t=>t.classList.remove("active"));
      document.getElementById("rtab-"+btn.dataset.tab)?.classList.add("active");
    });
  });

  document.getElementById("rosterGroupFilter")?.addEventListener("change", e=>{
    selectedGroup=e.target.value; renderRoster();
  });

  document.getElementById("logoutBtnRoster")?.addEventListener("click",()=>
    signOut(auth).then(()=>window.location.href="../index.html")
  );
}
