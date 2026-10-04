
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, query, where, onSnapshot, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const const firebaseConfig = {
  apiKey: "AIzaSyC0Vpi3jDeQViRie-y8LbUU8MAxAsNsjfg",
  authDomain: "sugar-distribution-syste-c2ef3.firebaseapp.com",
  projectId: "sugar-distribution-syste-c2ef3",
  appId: "1:217317887183:web:27902b9d85894608d4fbba"
};

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getFirestore(app);
const mail = u => u.trim().toLowerCase() + "@sugar-system.app";

export const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
export const removeFestival = ids => {
  const b = writeBatch(db);
  ids.forEach(id => b.delete(doc(db, "festival", id)));
  return b.commit();
};
// Yearly profile update: details, season, sugarcane supplied, monthly sugar quota.
export const updateShareholder = (sh, data) => {
  const b = writeBatch(db);
  b.update(doc(db, "shareholders", sh.id), data);
  if (data.name) b.update(doc(db, "users", sh.uid), { name: data.name });
  return b.commit();
};
export const setStock = total => setDoc(doc(db, "settings", "stock"), { total });
export const savePayment = data => setDoc(doc(db, "settings", "payment"), { ...data, updatedAt: serverTimestamp() });
export const setPaymentStatus = (id, status) => updateDoc(doc(db, "payments", id), { status });

/* ---------- shareholder writes ---------- */
export const submitPayment = p => setDoc(doc(collection(db, "payments")), { ...p, status: "pending", createdAt: serverTimestamp() });
