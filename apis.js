/* ===================================================================
   apis.js - the ONLY file that talks to Firebase.
   =================================================================== */
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, updateDoc, query, where, onSnapshot, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC0Vpi3jDeQViRie-y8LbUU8MAxAsNsjfg",
  authDomain: "sugar-distribution-syste-c2ef3.firebaseapp.com",
  projectId: "sugar-distribution-syste-c2ef3",
  appId: "1:217317887183:web:27902b9d85894608d4fbba"
};

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getFirestore(app);
const mail = u => u.trim().toLowerCase() + "@sugar-system.app";

export const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Month list used by the pages: [{ key: "2026-10", label: "October 2026" }, ...]
export const monthOptions = (from, count) => Array.from({ length: count }, (_, i) => {
  const n = new Date(), d = new Date(n.getFullYear(), n.getMonth() + from + i, 1);
  return { key: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"), label: d.toLocaleString("en-US", { month: "long", year: "numeric" }) };
});

/* ---------- auth ---------- */
export async function login(username, password) {
  let cred;
  try { cred = await signInWithEmailAndPassword(auth, mail(username), password); }
  catch (e) {
    const bad = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"];
    throw new Error(bad.includes(e.code) ? "Wrong username or password." : "Sign-in failed (" + e.code + "). Check firebaseConfig in apis.js.");
  }
  const s = await getDoc(doc(db, "users", cred.user.uid));
  if (!s.exists() || s.data().active === false) {
    await signOut(auth);
    throw new Error("This account is not active. Ask the admin to add you.");
  }
  return s.data();
}
export const logout = () => signOut(auth).then(() => location.replace("index.html"));

// Page guard: resolves with the profile only if the signed-in user has this role.
const bounce = why => location.replace("index.html?e=" + encodeURIComponent(why));
export const guard = role => new Promise(res => {
  const off = onAuthStateChanged(auth, async u => {
    off();
    if (!u) return bounce("session");
    let d;
    try { const s = await getDoc(doc(db, "users", u.uid)); d = s.exists() && s.data(); }
    catch (e) { return bounce("db-" + (e.code || "error")); }
    if (!d || d.active === false) { await signOut(auth); return bounce("profile"); }
    if (d.role !== role) { await signOut(auth); return bounce("role"); }
    res({ uid: u.uid, ...d });
  });
});

/* ---------- reads (live) ---------- */
// A failed read shows a banner (id="dbErr") instead of failing silently.
const fail = (what, e) => {
  console.error(what, e);
  const b = document.getElementById("dbErr");
  if (b) { b.hidden = false; b.textContent = "Could not load " + what + " (" + (e.code || e.message) + "). Check the database rules, then refresh."; }
};
export const watch = (col, cb, uid) => onSnapshot(
  uid ? query(collection(db, col), where("uid", "==", uid)) : collection(db, col),
  s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), e => fail(col, e));
export const watchDoc = (path, cb) => onSnapshot(doc(db, ...path.split("/")),
  s => cb(s.exists() ? s.data() : null), e => fail(path, e));

/* ---------- writes ---------- */
// Firestore allows only 20 rule lookups per batch, so big jobs are saved in small groups.
const CH = 6;
const commitAll = async ops => {
  for (let i = 0; i < ops.length; i += CH) {
    const b = writeBatch(db);
    ops.slice(i, i + CH).forEach(f => f(b));
    await b.commit();
  }
};
const note = (b, what, detail) => b.set(doc(collection(db, "log")), { what, detail, by: auth.currentUser?.uid || "", createdAt: serverTimestamp() });

export async function addShareholder(sh, username, password) {
  const ref = doc(db, "shareholders", sh.id);
  if ((await getDoc(ref)).exists()) throw new Error("Shareholder ID already exists.");
  // A second app instance creates the login so the admin stays signed in.
  const sa = initializeApp(firebaseConfig, "s" + Date.now()), sauth = getAuth(sa);
  let uid;
  try { uid = (await createUserWithEmailAndPassword(sauth, mail(username), password)).user.uid; }
  catch (e) {
    throw new Error(e.code === "auth/email-already-in-use" ? "That username is already taken."
      : e.code === "auth/weak-password" ? "Password must be at least 6 characters." : e.message);
  } finally { await signOut(sauth).catch(() => {}); deleteApp(sa); }
  const user = username.trim().toLowerCase(), b = writeBatch(db);
  b.set(ref, { ...sh, username: user, uid, createdAt: serverTimestamp() });
  b.set(doc(db, "users", uid), { role: "shareholder", shareholderId: sh.id, name: sh.name, username: user, active: true });
  return b.commit();
}
// Removing the profile locks the login out of every page and all data.
export const removeShareholder = sh => {
  const b = writeBatch(db);
  b.delete(doc(db, "shareholders", sh.id)); b.delete(doc(db, "users", sh.uid));
  return b.commit();
};
// Manual edit of a shareholder (details, season, cane, shortlist). Every edit is logged.
export const updateShareholder = (sh, data, changes) => {
  const b = writeBatch(db);
  b.update(doc(db, "shareholders", sh.id), data);
  if (data.name) b.update(doc(db, "users", sh.uid), { name: data.name });
  note(b, "edit", sh.id + " " + sh.name + " - " + changes);
  return b.commit();
};
// Factory list: hits = Map(shareholderId -> { tons }). Everyone else is taken off the shortlist.
export const applyShortlist = (season, hits, allIds) => commitAll([
  ...allIds.map(id => b => b.update(doc(db, "shareholders", id), hits.has(id)
    ? { shortlisted: true, season, caneTons: hits.get(id).tons }
    : { shortlisted: false, season, caneTons: 0 })),
  b => note(b, "list", "Factory list for " + season + ": " + hits.size + " shortlisted out of " + allIds.length)
]);

export const addFestival = list => commitAll(list.map(x => b =>
  b.set(doc(collection(db, "festival")), { ...x, createdAt: serverTimestamp() })));
export const removeFestival = ids => commitAll(ids.map(id => b => b.delete(doc(db, "festival", id))));

export const setStock = total => setDoc(doc(db, "settings", "stock"), { total });
export const savePayment = data => setDoc(doc(db, "settings", "payment"), { ...data, updatedAt: serverTimestamp() });

// Global declared values: sugar per shareholder per month (kg) and price per kg. Used by allocation and billing.
export const saveGlobal = (monthlyKg, pricePerKg) => {
  const b = writeBatch(db);
  b.set(doc(db, "settings", "global"), { monthlyKg, pricePerKg, updatedAt: serverTimestamp() });
  note(b, "global", "Declared sugar " + monthlyKg + " kg per month, price ₹" + pricePerKg + " per kg");
  return b.commit();
};

/* ---------- monthly allocation ---------- */
// One entitlement per shareholder per month. The id is fixed, so a month can never be given twice.
export const allocateMonth = (month, list) => commitAll([
  ...list.map(x => b => b.set(doc(db, "entitlements", month.key + "_" + x.shareholderId), { ...x, monthKey: month.key, month: month.label, createdAt: serverTimestamp() })),
  b => note(b, "allocate", month.label + ": sugar allocated to " + list.length + " shareholder(s)")
]);

/* ---------- bills ---------- */
export const createBill = async bill => {
  const r = doc(collection(db, "bills"));
  await setDoc(r, { ...bill, status: "unpaid", createdAt: serverTimestamp() });
  return r.id;
};
export const markBillPaid = (id, method, ref) => updateDoc(doc(db, "bills", id), { status: "paid", method, ref, paidAt: serverTimestamp() });
export const cancelBill = id => updateDoc(doc(db, "bills", id), { status: "cancelled" });

const sheetCss = `<style>
#billModal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99;overflow:auto;padding:20px;font-family:Arial,Helvetica,sans-serif}
#billModal .sheet{background:#fff;color:#111;max-width:560px;margin:0 auto;padding:28px;border-radius:10px}
#billModal h2{text-align:center;margin-bottom:4px}
#billModal .sub{text-align:center;color:#555;margin-bottom:18px}
#billModal .meta{display:flex;justify-content:space-between;margin-bottom:14px;font-size:14px}
#billModal table{width:100%;border-collapse:collapse}
#billModal td{padding:9px 6px;border-bottom:1px solid #ddd;font-size:14px}
#billModal td:first-child{color:#555;width:42%}
#billModal .stamp{margin:18px 0;text-align:center;font-weight:bold;font-size:18px;padding:8px;border-radius:8px;border:2px solid}
#billModal .paid{color:#166534}#billModal .unpaid{color:#92400e}#billModal .cancelled{color:#991b1b}
#billModal .qr{display:block;margin:10px auto;max-width:300px;width:100%}
#billModal .big{text-align:center;font-size:22px;font-weight:bold;margin:8px 0}
#billModal .acts{display:flex;gap:10px;justify-content:center;margin-top:16px}
#billModal button{padding:10px 16px;border:0;border-radius:7px;background:#2563eb;color:#fff;cursor:pointer}
#billModal button.g{background:#6b7280}
@media print{body>*:not(#billModal){display:none!important}#billModal{position:static;background:none;padding:0}#billModal .acts{display:none}}
</style>`;
const open = html => {
  document.getElementById("billModal")?.remove();
  const m = document.createElement("div"); m.id = "billModal"; m.innerHTML = sheetCss + html;
  document.body.appendChild(m);
};
const closeBtn = `<button class="g" onclick="document.getElementById('billModal').remove()">Close</button>`;

// Printable bill (Print button also lets you Save as PDF).
export function showBill(b, info = {}) {
  const row = (a, v) => `<tr><td>${a}</td><td>${esc(v)}</td></tr>`;
  const when = (b.createdAt?.toDate ? b.createdAt.toDate() : new Date()).toLocaleDateString("en-IN");
  const st = b.status || "unpaid", label = st === "paid" ? "PAID" : st === "cancelled" ? "CANCELLED" : "NOT PAID YET";
  const n = (b.months || []).length, same = b.kgPerMonth && b.kgPerMonth * n === b.kg;
  open(`<div class="sheet"><h2>${esc(b.org || "Sugar Distribution")}</h2><div class="sub">Sugar Bill</div>
<div class="meta"><span>Bill No: <b>${esc(b.billNo)}</b></span><span>Date: ${when}</span></div>
<table>${row("Shareholder", b.name)}${row("Shareholder ID", b.shareholderId)}${info.village ? row("Village", info.village) : ""}${info.mobile ? row("Mobile", info.mobile) : ""}${b.season ? row("Season", b.season) : ""}${row("Months", (b.months || []).join(", "))}${row("Sugar", b.kg + " kg" + (same ? " (" + b.kgPerMonth + " kg x " + n + ")" : ""))}${row("Rate", "₹" + b.rate + " per kg")}${row("Amount", "₹" + b.amount)}${st === "paid" ? row("Paid by", (b.method === "cash" ? "Cash" : "Online (UPI)") + (b.ref && b.method !== "cash" ? " - " + b.ref : "")) : ""}</table>
<div class="stamp ${st}">${label}</div>
<div class="acts"><button onclick="window.print()">Print / Save as PDF</button>${closeBtn}</div></div>`);
}

// Full-screen QR for the admin to show the shareholder.
export function showQr(b, ps = {}) {
  open(`<div class="sheet"><h2>${esc(ps.orgName || b.org || "Sugar Distribution")}</h2><div class="sub">Scan to pay - Bill ${esc(b.billNo)}</div>
<div class="big">₹${esc(b.amount)}</div>
${ps.qrImage ? `<img class="qr" src="${ps.qrImage}" alt="Payment QR">` : `<p style="text-align:center;color:#991b1b;margin:14px 0">No QR photo saved yet. Add it in Billing.</p>`}
${ps.upiId ? `<p style="text-align:center">UPI ID: <b>${esc(ps.upiId)}</b></p>` : ""}${ps.note ? `<p style="text-align:center;color:#555;margin-top:6px">${esc(ps.note)}</p>` : ""}
<div class="acts">${closeBtn}</div></div>`);
}
