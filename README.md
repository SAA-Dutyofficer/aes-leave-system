# AES Leave Management System — Setup Guide

## Overview
- 118 employees: 102 shift workers (4W4O pattern), 16 GD staff (Mon–Thu)
- 4 shifts: White, Red, Black, Green
- 6 GD sections: AES Management, LFS, L&D, Admin, Logistics, EP&S
- 7 leave types: Annual, Unpaid, Sick, Emergency, Compassionate, National Service, Exam
- 3-level approval: Officer → Fire Admin → Head of Operations
- Max 4 staff per shift on leave at same time (warning only)
- Max 3 annual leave requests per cycle (shift staff), 4 (GD staff)

## File structure
```
index.html           ← Login page
pages/
  staff.html         ← Staff portal
  manager.html       ← Manager/approver dashboard
css/
  main.css           ← All styles
js/
  firebase.js        ← Firebase config (UPDATE THIS FIRST)
  auth.js            ← Login + role-based redirect
  staff.js           ← Staff portal logic
  manager.js         ← Manager portal + approval logic
  utils.js           ← Shared helpers
firestore.rules      ← Firestore security rules
```

## Step 1 — Create Firebase project
1. Go to console.firebase.google.com
2. Add project → name it (e.g. aes-leave-system)
3. Enable Firestore Database → Start in production mode
4. Enable Authentication → Email/Password

## Step 2 — Add Firebase config
Copy your project config from Firebase Console → Project Settings → Your apps → Add web app
Replace ALL the REPLACE_WITH_YOUR_... values in:
- js/firebase.js
- js/manager.js (the secondaryAuth section — same config, copy again)

## Step 3 — Firestore Rules
Firebase Console → Firestore → Rules → paste firestore.rules contents → Publish

## Step 4 — Create your first admin account
1. Firebase Console → Authentication → Add user → email + password
2. Copy the UID
3. Firestore → Create collection: users → Document ID = your UID
4. Fields:
   - name: Your Name
   - email: your@email.com
   - role: head_ops  (or fire_admin, or officer)
5. Save
6. Firestore → Create collection: employees → Document ID = same UID
7. Fields:
   - name, email, dept: GD, joinDate: 2024-01-01
   - cycleStart: 2025-01-01, entitlement: 30
   - leaveUsed: 0, role: head_ops

## Step 5 — Deploy via GitHub Pages
1. Push all files to GitHub repo (root level — index.html must be at root)
2. Settings → Pages → main branch → Save
3. Add your GitHub Pages domain to Firebase Console → Authentication → Authorized domains

## Roles
- staff       → Staff portal only (submit leave, view team)
- officer     → Manager portal, approves level 1 (their shift/section only)
- fire_admin  → Manager portal, approves level 2 (after officer)
- head_ops    → Manager portal, final approval level 3

## Shift pattern
Shift workers use 4W4O (4 on, 4 off) cycle.
The "Cycle Start Date" when adding an employee is used as the reference date for their shift pattern.
Pattern field should be left as "2W2N4O" for display purposes only — leave counting uses 4W4O logic.

## Adding employees in bulk
Log in as head_ops or fire_admin → Employees tab → Add Employee
Repeat for each employee. They can log in immediately after being added.
