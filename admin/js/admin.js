import { firebaseConfig } from "../../js/firebase-config.js";

import { initializeApp } from 
"https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 
"https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  orderBy,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  deleteField
} from 
"https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const cfg = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);

const state = { user: null, admin: null, classes: [], members: [], vouchers: new Map(), page: "dashboard" };
const pendingRequests = new Map();

bindUi();
onAuthStateChanged(auth, handleAuthState);

function bindUi() {
  $("loginForm").addEventListener("submit", login);
  $("logoutButton").addEventListener("click", async () => { if(await askConfirm("🚪 Logout", "Yakin ingin keluar dari dashboard admin?", "Logout")) signOut(auth); });
  $("actionCancel").onclick=()=>$("actionDialog").close();
  $("linkClose").onclick=()=>$("linkDialog").close();
  document.querySelectorAll(".nav-btn[data-page]").forEach((btn) => btn.addEventListener("click", () => openPage(btn.dataset.page)));
  $("classForm").addEventListener("submit", saveClass);
  $("classReset").addEventListener("click", resetClassForm);
  $("memberSearch").addEventListener("input", renderMembers);
  $("memberClassFilter").addEventListener("change", renderMembers);
  $("voucherClassSelect").addEventListener("change", () => loadVouchers($("voucherClassSelect").value));
  $("singleVoucherForm").addEventListener("submit", addSingleVoucher);
  $("bulkVoucherForm").addEventListener("submit", addVoucherBatch);
  $("deleteSelectedVouchers").addEventListener("click", deleteSelectedVouchers);
  $("voucherSelectAll").addEventListener("change", toggleAllVoucherCheckbox);
  $("exportButton").addEventListener("click", exportSpreadsheet);
  $("exportExcelButton").addEventListener("click", exportExcel);
  $("memberDialogClose").addEventListener("click", () => $("memberDialog").close());
  $("memberCancel").addEventListener("click", () => $("memberDialog").close());
  $("memberEditForm").addEventListener("submit", saveMemberEdit);
  window.addEventListener("message", handleBridgeMessage);
}

async function login(event) {
  event.preventDefault();
  show($("loginStatus"), "Memeriksa akun...", "info");
  try {
    await signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPassword").value);
  } catch (error) {
    show($("loginStatus"), friendlyAuthError(error), "error");
  }
}

async function handleAuthState(user) {
  if (!user) {
    state.user = null; state.admin = null;
    $("adminView").classList.add("hidden"); $("loginView").classList.remove("hidden");
    return;
  }
  try {
    const adminSnap = await getDoc(doc(db, "admins", user.uid));
    if (!adminSnap.exists() || adminSnap.data().role !== "admin" || adminSnap.data().active !== true) {
      await signOut(auth);
      show($("loginStatus"), "Akun ini belum memiliki akses admin aktif.", "error");
      return;
    }
    state.user = user; state.admin = adminSnap.data();
    $("loginView").classList.add("hidden"); $("adminView").classList.remove("hidden");
    $("adminIdentity").textContent = state.admin.name || user.email || "Admin";
    await loadAll();
  } catch (error) {
    show($("loginStatus"), error.message || String(error), "error");
  }
}

async function loadAll() {
  await Promise.all([loadClasses(), loadMembers()]);
  await loadVoucherStats();
  renderDashboard(); renderMembers(); renderClasses(); populateClassSelects();
  const first = state.classes[0]?.code || "";
  if (first) { $("voucherClassSelect").value = first; await loadVouchers(first); }
}

async function loadClasses() {
  const snap = await getDocs(query(collection(db, "classes"), orderBy("createdAt", "desc")));
  state.classes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadMembers() {
  const snap = await getDocs(collection(db, "members"));
  state.members = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a,b) => Number(a.registrationNumber || 0) - Number(b.registrationNumber || 0));
}

async function loadVoucherStats() {
  let available = 0, assigned = 0;
  for (const cls of state.classes) {
    const snap = await getDocs(collection(db, "classes", cls.code, "vouchers"));
    const vouchers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    state.vouchers.set(cls.code, vouchers);
    vouchers.forEach((v) => v.status === "available" ? available++ : assigned++);
  }
  $("statAvailableVouchers").textContent = available;
  $("statAssignedVouchers").textContent = assigned;
}

function renderDashboard() {
  $("statMembers").textContent = state.members.length; $("statClasses").textContent = state.classes.length;
  const container = $("dashboardClasses"); container.replaceChildren();
  if (!state.classes.length) { container.textContent = "Belum ada kelas."; return; }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Kode</th><th>Nama</th><th>Status</th><th>Anggota</th><th>Voucher tersedia</th></tr></thead><tbody></tbody>`;
  const body = table.querySelector("tbody");
  state.classes.slice(0, 8).forEach((cls) => {
    const memberCount = state.members.filter((m) => m.classId === cls.code).length;
    const available = (state.vouchers.get(cls.code) || []).filter((v) => v.status === "available").length;
    const tr = document.createElement("tr"); tr.innerHTML = `<td>${esc(cls.code)}</td><td>${esc(cls.name || "-")}</td><td>${statusHtml(cls.status)}</td><td>${memberCount}</td><td>${available}</td>`; body.appendChild(tr);
  });
  container.appendChild(table);
}

function renderMembers() {
  const term = $("memberSearch").value.trim().toLowerCase(); const cls = $("memberClassFilter").value;
  const rows = state.members.filter((m) => (!cls || m.classId === cls) && (!term || String(m.nik || m.id).includes(term) || String(m.name || "").toLowerCase().includes(term)));
  const body = $("memberTableBody"); body.replaceChildren();
  rows.forEach((m) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(m.registrationNumber ?? "-")}</td><td>${esc(maskNik(m.nik || m.id))}</td><td>${esc(m.name || "-")}</td><td>${esc(m.classId || "-")}</td><td>${esc(m.voucherCode || "-")}</td><td>${esc(m.shirtSize || "-")}</td><td><button class="mini-btn edit">Edit</button><button class="mini-btn danger delete">Hapus</button></td>`;
    tr.querySelector(".edit").addEventListener("click", () => openMemberEdit(m));
    tr.querySelector(".delete").addEventListener("click", () => deleteMember(m)); body.appendChild(tr);
  });
  if (!rows.length) body.innerHTML = `<tr><td colspan="7">Tidak ada data.</td></tr>`;
}

function renderClasses() {
  const body = $("classTableBody"); body.replaceChildren();
  state.classes.forEach((cls) => {
    const link = publicClassLink(cls.code);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(cls.code)}</td><td>${esc(cls.name || "-")}</td><td>${esc(cls.startDate || "-")}</td><td>${esc(cls.endDate || "-")}</td><td>${statusHtml(cls.status)}</td><td><button class="mini-btn copy">Salin Link</button></td><td><button class="mini-btn edit">Edit</button><button class="mini-btn danger delete">Hapus</button></td>`;
    tr.querySelector(".copy").addEventListener("click", async () => { openLinkDialog(cls, link); });
    tr.querySelector(".edit").addEventListener("click", () => editClass(cls));
    tr.querySelector(".delete").addEventListener("click", () => removeClass(cls)); body.appendChild(tr);
  });
  if (!state.classes.length) body.innerHTML = `<tr><td colspan="7">Belum ada kelas.</td></tr>`;
}

function populateClassSelects() {
  const targets = [$("memberClassFilter"), $("voucherClassSelect"), $("exportClassSelect")];
  targets.forEach((select, index) => {
    const current = select.value;
    const firstOption = index === 1 ? `<option value="">Pilih kelas</option>` : `<option value="">Semua kelas</option>`;
    select.innerHTML = firstOption + state.classes.map((c) => `<option value="${escAttr(c.code)}">${esc(c.name || c.code)} (${esc(c.code)})</option>`).join("");
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  });
}

async function saveClass(event) {
  event.preventDefault();
  const original = $("classOriginalCode").value; const code = $("classCode").value.trim().toUpperCase();
  const name = $("className").value.trim(); const startDate = $("classStartDate").value; const endDate = $("classEndDate").value; const status = $("classStatusInput").value;
  if (!/^[A-Z0-9_-]{4,20}$/.test(code)) return show($("classFormStatus"), "Kode kelas 4-20 karakter: huruf, angka, _ atau -.", "error");
  if (name.length < 2) return show($("classFormStatus"), "Nama kelas wajib diisi.", "error");
  if (startDate && endDate && startDate > endDate) return show($("classFormStatus"), "Tanggal selesai tidak boleh sebelum tanggal mulai.", "error");
  if (original && original !== code) return show($("classFormStatus"), "Kode kelas tidak dapat diubah setelah dibuat.", "error");
  try {
    const ref = doc(db, "classes", code); const existing = await getDoc(ref);
    if (!original && existing.exists()) return show($("classFormStatus"), "Kode kelas sudah digunakan.", "error");
    if (existing.exists()) await updateDoc(ref, { name, startDate, endDate, status, updatedAt: serverTimestamp() });
    else await setDoc(ref, { code, name, startDate, endDate, status, registrationSeq: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    show($("classFormStatus"), "Kelas berhasil disimpan.", "success"); resetClassForm(); await refreshData();
  } catch (error) { show($("classFormStatus"), error.message || String(error), "error"); }
}

function editClass(cls) { $("classOriginalCode").value = cls.code; $("classCode").value = cls.code; $("classCode").readOnly = true; $("className").value = cls.name || ""; $("classStartDate").value = cls.startDate || ""; $("classEndDate").value = cls.endDate || ""; $("classStatusInput").value = cls.status || "active"; window.scrollTo({top:0,behavior:"smooth"}); }
function resetClassForm() { $("classForm").reset(); $("classOriginalCode").value = ""; $("classCode").readOnly = false; $("classStatusInput").value = "active"; }

async function removeClass(cls) {
  if (!(await askConfirm("🗑️ Hapus Kelas", `Kelas ${cls.code} akan dihapus. Tindakan ini tidak dapat dibatalkan.`, "Hapus"))) return;
  const members = state.members.filter((m) => m.classId === cls.code); const vouchers = state.vouchers.get(cls.code) || [];
  if (members.length || vouchers.length) return alert("Kelas masih memiliki anggota atau voucher. Kosongkan dulu.");
  await deleteDoc(doc(db, "classes", cls.code)); await refreshData();
}

async function loadVouchers(classCode) {
  const body = $("voucherTableBody"); body.innerHTML = `<tr><td colspan="4">Memuat...</td></tr>`;
  if (!classCode) { body.innerHTML = `<tr><td colspan="4">Pilih kelas.</td></tr>`; return; }
  const snap = await getDocs(collection(db, "classes", classCode, "vouchers"));
  const vouchers = snap.docs.map((d) => ({ id:d.id, ...d.data() })).sort((a,b) => String(a.code).localeCompare(String(b.code), undefined, {numeric:true}));
  state.vouchers.set(classCode, vouchers); renderVoucherRows(classCode, vouchers); await loadVoucherStats(); renderDashboard();
}

function renderVoucherRows(classCode, vouchers) {
  const body = $("voucherTableBody"); body.replaceChildren();
  vouchers.forEach((v) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input type="checkbox" class="voucher-check" data-id="${escAttr(v.id)}"></td><td>${esc(v.code || v.id)}</td><td>${statusHtml(v.status)}</td><td>${esc(v.memberNik ? maskNik(v.memberNik) : "-")}</td>`;
    body.appendChild(tr);
  });
  if (!vouchers.length) body.innerHTML = `<tr><td colspan="4">Belum ada voucher.</td></tr>`;
}

function toggleAllVoucherCheckbox() {
  document.querySelectorAll(".voucher-check").forEach((cb) => cb.checked = $("voucherSelectAll").checked);
}

async function deleteSelectedVouchers() {
  const classCode = $("voucherClassSelect").value;
  const selected = [...document.querySelectorAll(".voucher-check:checked")].map((cb) => cb.dataset.id);
  if (!classCode || !selected.length) return alert("Pilih voucher yang ingin dihapus.");

  if (!confirm(`Hapus ${selected.length} voucher terpilih?`)) return;

  const batch = writeBatch(db);
  selected.forEach((id) => batch.delete(doc(db, "classes", classCode, "vouchers", id)));
  await batch.commit();
  $("voucherSelectAll").checked = false;
  await loadVouchers(classCode);
}

async function addSingleVoucher(event) {
  event.preventDefault(); const classCode = $("voucherClassSelect").value; const code = $("singleVoucherCode").value.trim().toUpperCase();
  if (!classCode) return show($("voucherStatus"), "Pilih kelas terlebih dahulu.", "error");
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return show($("voucherStatus"), "Format kode voucher tidak valid.", "error");
  const ref = doc(db, "classes", classCode, "vouchers", code); if ((await getDoc(ref)).exists()) return show($("voucherStatus"), "Voucher sudah ada di kelas ini.", "error");
  await setDoc(ref, { code, status:"available", memberNik:"", createdAt:serverTimestamp() }); $("singleVoucherCode").value=""; show($("voucherStatus"), "Voucher ditambahkan.", "success"); await loadVouchers(classCode);
}

async function addVoucherBatch(event) {
  event.preventDefault(); const classCode = $("voucherClassSelect").value; const prefix = $("voucherPrefix").value.trim().toUpperCase();
  const count = Number($("voucherCount").value);
  const classIndex = Math.max(0, state.classes.findIndex(c => c.code === classCode)) + 1;
  const classNumber = String(classIndex).padStart(2,"0");
  if (!classCode) return show($("voucherStatus"), "Pilih kelas terlebih dahulu.", "error");
  if (!/^[A-Z0-9_-]{1,15}$/.test(prefix)) return show($("voucherStatus"), "Kode kelas tidak valid.", "error");
  if (!Number.isInteger(count) || count < 1 || count > 400) return show($("voucherStatus"), "Jumlah voucher 1-400.", "error");
  const existing = new Set((state.vouchers.get(classCode)||[]).map((v) => v.code || v.id));
  let next = 1;
  const codes = [];
  while (codes.length < count) {
    const code = prefix + classNumber + String(next).padStart(2,"0");
    if (!existing.has(code)) codes.push(code);
    next++;
  }
  const batch = writeBatch(db); codes.forEach((code) => batch.set(doc(db,"classes",classCode,"vouchers",code), {code,status:"available",memberNik:"",createdAt:serverTimestamp()}));
  await batch.commit(); show($("voucherStatus"), `${count} voucher berhasil dibuat (${codes[0]} s.d. ${codes[codes.length-1]}).`, "success"); await loadVouchers(classCode);
}

function openMemberEdit(m) {
  $("editNik").value = m.nik || m.id; $("editName").value = m.name || ""; $("editBirthPlace").value = m.birthPlace || ""; $("editBirthDate").value = m.birthDate || "";
  $("editMotherName").value = m.motherName || ""; $("editAddress").value = m.address || ""; $("editAccountNumber").value = m.accountNumber || ""; $("editBankName").value = m.bankName || ""; $("editAccountHolder").value = m.accountHolder || ""; $("editShirtSize").value = m.shirtSize || "L";
  $("memberEditStatus").classList.add("hidden"); $("memberDialog").showModal();
}

async function saveMemberEdit(event) {
  event.preventDefault(); const nik = $("editNik").value;
  try {
    await updateDoc(doc(db,"members",nik), { name:$("editName").value.trim(), birthPlace:$("editBirthPlace").value.trim(), birthDate:$("editBirthDate").value, motherName:$("editMotherName").value.trim(), address:$("editAddress").value.trim(), accountNumber:$("editAccountNumber").value.trim(), bankName:$("editBankName").value.trim(), accountHolder:$("editAccountHolder").value.trim(), shirtSize:$("editShirtSize").value, updatedAt:serverTimestamp() });
    $("memberDialog").close(); await loadMembers(); renderMembers(); renderDashboard();
  } catch (error) { show($("memberEditStatus"), error.message || String(error), "error"); }
}

async function deleteMember(m) {
  if (!(await askConfirm("🗑️ Hapus Peserta", `Data ${m.name} akan dihapus dan voucher dikembalikan.`, "Hapus"))) return;
  const batch = writeBatch(db); batch.delete(doc(db,"members",m.nik || m.id));
  if (m.classId && m.voucherCode) batch.update(doc(db,"classes",m.classId,"vouchers",m.voucherCode), { status:"available", memberNik:"", assignedAt:deleteField() });
  await batch.commit(); await refreshData(); if ($("voucherClassSelect").value) await loadVouchers($("voucherClassSelect").value);
}

async function exportExcel() {
  try {
    const selected = $("exportClassSelect").value;
    let rows = state.members.map((m,i)=>({No:i+1, "Nomor Identitas":m.nik||m.id||"", "Nama Lengkap":m.name||"", "Tanggal Lahir":m.birthDate||"", "Handphone":m.phone||m.handphone||"", "Email":m.email||"", "Alamat":m.address||"", "Nama Ibu Kandung":m.motherName||"", "Nama Pelatihan":(state.classes.find(c=>c.code===m.classId)||{}).name||m.classId||"", "Voucher":m.voucherCode||"", "Ukuran Baju":m.shirtSize||""}));
    if(selected) rows = rows.filter((r,i)=>state.members[i] && state.members[i].classId===selected);
    if(!rows.length) return show($("exportStatus"),"Tidak ada data peserta untuk diexport.","error");
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"]=[{wch:6},{wch:20},{wch:25},{wch:15},{wch:16},{wch:30},{wch:35},{wch:25},{wch:30},{wch:18},{wch:15}];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"Peserta");
    XLSX.writeFile(wb, selected ? `Peserta_${selected}.xlsx` : "Semua_Peserta.xlsx");
    show($("exportStatus"),"Export Excel berhasil dibuat.","success");
  } catch(e){ show($("exportStatus"),e.message||String(e),"error"); }
}

async function exportSpreadsheet() {
  if (!cfg.backendUrl || cfg.backendUrl.includes("PASTE_APPS_SCRIPT")) return show($("exportStatus"), "Google Sheet belum dikonfigurasi. Isi backendUrl di config.js untuk fitur ini.", "warning");
  $("exportButton").disabled = true; show($("exportStatus"), "Membuat Spreadsheet...", "info"); $("exportLink").classList.add("hidden");
  try {
    const idToken = await state.user.getIdToken(true); const response = await bridgeRequest("export", { idToken, classCode:$("exportClassSelect").value });
    if (!response.success) throw new Error(response.message || "Export gagal.");
    show($("exportStatus"), `Export berhasil: ${response.rowCount} peserta.`, "success"); $("exportLink").href = response.spreadsheetUrl; $("exportLink").classList.remove("hidden");
  } catch (error) { show($("exportStatus"), error.message || String(error), "error"); }
  finally { $("exportButton").disabled = false; }
}

async function refreshData() { await Promise.all([loadClasses(),loadMembers()]); await loadVoucherStats(); renderDashboard(); renderMembers(); renderClasses(); populateClassSelects(); }

function openPage(page) {
  state.page = page; document.querySelectorAll(".page-section").forEach((s)=>s.classList.add("hidden")); $("page-"+page).classList.remove("hidden");
  document.querySelectorAll(".nav-btn[data-page]").forEach((b)=>b.classList.toggle("active",b.dataset.page===page));
  const titles={dashboard:["Dashboard","Ringkasan data keanggotaan."],members:["Anggota","Kelola data anggota."],classes:["Kelas","Buat kelas dan link pendaftaran."],vouchers:["Voucher","Voucher selalu terikat ke kelas."],export:["Export","Kirim data Firestore ke Google Spreadsheet."]};
  $("pageTitle").textContent=titles[page][0]; $("pageSubtitle").textContent=titles[page][1];
}


function askConfirm(title,text,button="Lanjut") {
 return new Promise(resolve=>{
  $("actionTitle").textContent=title; $("actionText").textContent=text; $("actionConfirm").textContent=button;
  const btn=$("actionConfirm"); const handler=()=>{btn.removeEventListener("click",handler); $("actionDialog").close(); resolve(true)};
  btn.addEventListener("click",handler); $("actionDialog").showModal();
  $("actionDialog").addEventListener("close",()=>resolve(false),{once:true});
 });
}
function openLinkDialog(cls, link){
 $("linkClassName").textContent=cls.name || cls.code; $("linkValue").value=link;
 $("linkDialog").showModal();
 $("linkCopy").onclick=async()=>{await navigator.clipboard.writeText(link); $("linkCopy").textContent="✅ Tersalin";};
 $("linkGo").onclick=()=>window.open(link,"_blank");
}

function publicClassLink(code) {
  // Selalu arahkan ke halaman publik (index.html), bukan kembali ke folder admin
  const url = new URL(window.location.href);
  const adminPath = url.pathname.replace(/\\/g, "/");
  const rootPath = adminPath.includes("/admin/")
    ? adminPath.split("/admin/")[0] + "/"
    : adminPath.substring(0, adminPath.lastIndexOf("/") + 1);
  url.pathname = rootPath;
  url.search = "";
  url.hash = "";
  url.searchParams.set("kelas", code);
  return url.toString();
}
function statusHtml(status) { return `<span class="status ${escAttr(status || "closed")}">${esc(status || "-")}</span>`; }
function maskNik(nik) { const s=String(nik||""); return s.length===16 ? `${s.slice(0,6)}******${s.slice(-4)}` : s; }
function esc(value){return String(value??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function escAttr(value){return esc(value).replace(/`/g,"&#096;");}
function show(el,msg,type){el.className=`alert alert-${type}`;el.textContent=msg;el.classList.remove("hidden");}
function friendlyAuthError(error){const c=error?.code||"";if(c.includes("invalid-credential"))return"Email atau password salah.";if(c.includes("too-many-requests"))return"Terlalu banyak percobaan login. Coba lagi nanti.";return error.message||String(error);}

function bridgeRequest(action,payload){return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID?.()||`${Date.now()}-${Math.random()}`;const form=document.createElement("form");form.method="POST";form.action=cfg.backendUrl;form.target="apiBridgeFrame";form.style.display="none";Object.entries({action,requestId,frontendOrigin:location.origin,...payload}).forEach(([k,v])=>{const input=document.createElement("input");input.type="hidden";input.name=k;input.value=String(v??"");form.appendChild(input)});const timer=setTimeout(()=>{pendingRequests.delete(requestId);reject(new Error("Backend Apps Script tidak merespons."))},Number(cfg.requestTimeoutMs||45000));pendingRequests.set(requestId,{resolve:(d)=>{clearTimeout(timer);resolve(d)}});document.body.appendChild(form);form.submit();form.remove()})}
function handleBridgeMessage(event){let trusted=false;try{const h=new URL(event.origin).hostname;trusted=h==="script.google.com"||h.endsWith("script.googleusercontent.com")}catch{}if(!trusted)return;const d=event.data;if(!d||d.source!=="anggota-registration-api"||!d.requestId)return;const p=pendingRequests.get(d.requestId);if(!p)return;pendingRequests.delete(d.requestId);p.resolve(d)}
