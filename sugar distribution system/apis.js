/* ===================================================================
   apis.js - the ONLY file that talks to Firebase.
   1. Paste your Firebase web config below (Project settings > Your apps).
   2. Enable Authentication > Email/Password and create Firestore.
   3. Create the admin: Authentication > Add user  admin@sugar-system.app
      then in Firestore add  users/<that user's UID>  =
      { role: "admin", name: "Admin", username: "admin", active: true }
   4. Paste these rules in Firestore > Rules (the pages' checks are only
      for convenience; THESE rules are what actually protect the data):

   rules_version = '2';
   service cloud.firestore { match /databases/{d}/documents {
     function live(){ return request.auth != null &&
       exists(/databases/$(d)/documents/users/$(request.auth.uid)); }
     function admin(){ return live() &&
       get(/databases/$(d)/documents/users/$(request.auth.uid)).data.role == 'admin'; }
     function mine(){ return live() && resource.data.uid == request.auth.uid; }
     match /users/{u} { allow read: if request.auth.uid == u || admin(); allow write: if admin(); }
     match /shareholders/{s} { allow read: if admin() || mine(); allow write: if admin(); }
     match /records/{r}  { allow read: if admin() || mine(); allow write: if admin(); }
     match /festival/{r} { allow read: if admin() || mine(); allow write: if admin(); }
     match /payments/{p} {
       allow read: if admin() || mine();
       allow create: if live() && request.resource.data.uid == request.auth.uid
                        && request.resource.data.status == 'pending';
       allow update: if admin();
     }
     match /settings/payment { allow read: if live(); allow write: if admin(); }
     match /settings/stock   { allow read, write: if admin(); }
   }}
   =================================================================== */
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, query, where, onSnapshot, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getFirestore(app);
const mail = u => u.trim().toLowerCase() + "@sugar-system.app";

export const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- auth ---------- */
export async function login(username, password) {
  let cred;
  try { cred = await signInWithEmailAndPassword(auth, mail(username), password); }
  catch { throw new Error("Wrong username or password."); }
  const s = await getDoc(doc(db, "users", cred.user.uid));
  if (!s.exists() || s.data().active === false) {
    await signOut(auth);
    throw new Error("This account is not active. Ask the admin to add you.");
  }
  return s.data();
}
export const logout = () => signOut(auth).then(() => location.replace("index.html"));

// Page guard: resolves with the profile only if the signed-in user has this role.
export const guard = role => new Promise(res => {
  const off = onAuthStateChanged(auth, async u => {
    off();
    if (!u) return location.replace("index.html");
    const s = await getDoc(doc(db, "users", u.uid));
    const d = s.exists() && s.data();
    if (!d || d.active === false || d.role !== role) {
      await signOut(auth);
      return location.replace("index.html");
    }
    res({ uid: u.uid, ...d });
  });
});

/* ---------- reads (live) ---------- */
export const watch = (col, cb, uid) => onSnapshot(
  uid ? query(collection(db, col), where("uid", "==", uid)) : collection(db, col),
  s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), e => console.error(col, e));
export const watchDoc = (path, cb) => onSnapshot(doc(db, ...path.split("/")),
  s => cb(s.exists() ? s.data() : null), e => console.error(path, e));
export const getShareholder = async id => (s => s.exists() ? s.data() : null)(await getDoc(doc(db, "shareholders", id)));

/* ---------- admin writes ---------- */
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
const addMany = (col, list) => {
  const b = writeBatch(db);
  list.forEach(x => b.set(doc(collection(db, col)), { ...x, createdAt: serverTimestamp() }));
  return b.commit();
};
export const addRecords = l => addMany("records", l);
export const addFestival = l => addMany("festival", l);
export const setStock = total => setDoc(doc(db, "settings", "stock"), { total });
export const savePayment = data => setDoc(doc(db, "settings", "payment"), { ...data, updatedAt: serverTimestamp() });
export const setPaymentStatus = (id, status) => updateDoc(doc(db, "payments", id), { status });

/* ---------- shareholder writes ---------- */
export const submitPayment = p => setDoc(doc(collection(db, "payments")), { ...p, status: "pending", createdAt: serverTimestamp() });
