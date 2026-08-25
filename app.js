(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const pendingRequests = new Map();
  let previewState = null;
  let accountHolderWasEdited = false;
  let activeClass = null;

  const $ = (id) => document.getElementById(id);
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    $("birthDate").max = new Date().toISOString().slice(0, 10);
    $("registrationForm").addEventListener("submit", handlePreview);
    $("bankPending").addEventListener("change", toggleBankFields);
    $("bankName").addEventListener("change", toggleOtherBank);
    $("accountNumber").addEventListener("input", digitsOnly);
    $("nik").addEventListener("input", digitsOnly);
    $("name").addEventListener("input", syncAccountHolder);
    $("accountHolder").addEventListener("input", () => { accountHolderWasEdited = true; });
    $("backButton").addEventListener("click", backToEdit);
    $("submitButton").addEventListener("click", handleSubmit);
    window.addEventListener("message", handleBridgeMessage);

    validateConfig();
    toggleBankFields();
    toggleOtherBank();
    await loadClass();
  }

  function validateConfig() {
    const warning = $("setupWarning");
    if (!cfg.backendUrl || cfg.backendUrl.includes("PASTE_APPS_SCRIPT")) {
      showBox(warning, "Backend belum dikonfigurasi. Isi backendUrl di config.js dengan URL Apps Script /exec.", "warning");
      return;
    }
    if (!/^https:\/\/script\.google\.com\/.+\/exec(?:\?.*)?$/.test(cfg.backendUrl)) {
      showBox(warning, "backendUrl tidak terlihat seperti URL deployment Apps Script /exec.", "warning");
    }
  }

  async function loadClass() {
    const classCode = new URLSearchParams(window.location.search).get("kelas")?.trim().toUpperCase() || "";
    if (!classCode) {
      showBox($("classStatus"), "Link pendaftaran tidak memiliki kode kelas. Gunakan link yang diberikan admin.", "error");
      return;
    }
    if (!cfg.backendUrl || cfg.backendUrl.includes("PASTE_APPS_SCRIPT")) return;

    try {
      const response = await bridgeRequest("classInfo", { classCode });
      if (!response.success) throw new Error(response.message || "Kelas tidak ditemukan.");
      activeClass = response.classData;
      $("classNameText").textContent = activeClass.name || activeClass.code;
      $("classCodeText").textContent = activeClass.code;

      if (activeClass.status !== "active") {
        showBox($("classStatus"), "Pendaftaran kelas ini sedang ditutup oleh admin.", "warning");
        return;
      }
      if (Number(activeClass.availableVouchers || 0) <= 0) {
        showBox($("classStatus"), "Voucher kelas ini sedang habis. Silakan hubungi admin.", "warning");
        return;
      }

      showBox($("classStatus"), `Pendaftaran untuk ${activeClass.name || activeClass.code} aktif.`, "success");
      $("formSection").classList.remove("hidden");
    } catch (error) {
      showBox($("classStatus"), error.message || String(error), "error");
    }
  }

  function digitsOnly(event) { event.target.value = event.target.value.replace(/\D/g, ""); }
  function syncAccountHolder() { if (!accountHolderWasEdited && !$("bankPending").checked) $("accountHolder").value = $("name").value; }

  function toggleBankFields() {
    const pending = $("bankPending").checked;
    [$("accountNumber"), $("bankName"), $("accountHolder"), $("otherBankName")].forEach((el) => { el.disabled = pending; });
    if (pending) {
      $("accountNumber").value = ""; $("bankName").value = ""; $("otherBankName").value = ""; $("accountHolder").value = "";
      $("otherBankField").classList.add("hidden");
    } else {
      accountHolderWasEdited = false; syncAccountHolder(); toggleOtherBank();
    }
  }

  function toggleOtherBank() { $("otherBankField").classList.toggle("hidden", !(!$("bankPending").checked && $("bankName").value === "Lainnya")); }

  function collectFormData() {
    const bankPending = $("bankPending").checked;
    let bankName = $("bankName").value.trim();
    if (!bankPending && bankName === "Lainnya") bankName = $("otherBankName").value.trim();
    return {
      classCode: activeClass?.code || "",
      nik: $("nik").value.trim(), name: $("name").value.trim(), birthPlace: $("birthPlace").value.trim(), birthDate: $("birthDate").value,
      address: buildAddress(), motherName: $("motherName").value.trim(), bankPending,
      accountNumber: bankPending ? "" : $("accountNumber").value.trim(), bankName: bankPending ? "Menyusul" : bankName,
      accountHolder: bankPending ? "" : $("accountHolder").value.trim(), shirtSize: $("shirtSize").value
    };
  }

  function buildAddress(){

  const street =
    $("street").value.trim();

  const rt =
    $("rt").value.trim();

  const rw =
    $("rw").value.trim();

  const village =
    $("village").value.trim();

  const district =
    $("district").value.trim();

  const regency =
    $("regency").value.trim();

  const province =
    $("province").value.trim();


  return `${street}, RT ${rt}/RW ${rw}, Desa ${village}, Kec. ${district}, Kab. ${regency}, ${province}`;
}

  function validateData(data) {
    if (!/^\d{16}$/.test(data.nik)) return "NIK harus terdiri dari tepat 16 digit angka.";
    if (data.name.length < 2) return "Nama lengkap wajib diisi.";
    if (data.birthPlace.length < 2) return "Tempat lahir wajib diisi.";
    if (!data.birthDate) return "Tanggal lahir wajib diisi.";
    if (
 !$("street").value ||
 !$("rt").value ||
 !$("rw").value ||
 !$("village").value ||
 !$("district").value ||
 !$("regency").value ||
 !$("province").value
)
return "Alamat belum lengkap.";
    if (data.motherName.length < 2) return "Nama ibu wajib diisi.";
    if (!["S", "M", "L", "XL", "XXL", "XXXL"].includes(data.shirtSize)) return "Pilih ukuran baju.";
    if (!data.bankPending) {
      if (!/^\d{5,30}$/.test(data.accountNumber)) return "Nomor rekening harus 5 sampai 30 digit angka.";
      if (!data.bankName) return "Nama bank wajib diisi.";
      if (data.accountHolder.length < 2) return "Atas nama bank wajib diisi.";
    }
    if (!$("consent").checked) return "Centang persetujuan data terlebih dahulu.";
    return "";
  }

  async function handlePreview(event) {
    event.preventDefault();
    const data = collectFormData();
    const error = validateData(data);
    if (error) return showBox($("formStatus"), error, "error");
    setLoading($("previewButton"), true, "Memeriksa...");
    showBox($("formStatus"), "Memeriksa tempat lahir dan alamat...", "info");
    try {
      const response = await bridgeRequest("preview", data);
      if (!response.success) throw new Error(response.message || "Preview gagal.");
      previewState = { raw: data, suggestion: response.suggestion || {} };
      renderPreview(previewState);
      showBox($("formStatus"), response.aiAvailable === false ? "Preview siap. AI sedang tidak tersedia, teks asli dipertahankan." : "Preview siap. Periksa hasilnya sebelum mengirim.", response.aiAvailable === false ? "warning" : "success");
      $("previewSection").classList.remove("hidden");
      $("previewSection").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) { showBox($("formStatus"), error.message || String(error), "error"); }
    finally { setLoading($("previewButton"), false, "Periksa Data"); }
  }

  function renderPreview(state) {
    const { raw, suggestion } = state;
    $("previewNik").textContent = raw.nik; $("previewName").textContent = raw.name;
    $("originalBirthPlace").textContent = raw.birthPlace; $("finalBirthPlace").value = suggestion.birthPlace || raw.birthPlace;
    const birthConfidence = Math.round(Number(suggestion.birthPlaceConfidence || 0) * 100);
    $("birthPlaceMeta").textContent = `${suggestion.birthPlaceSource || "Input asli"} · confidence ${birthConfidence}%${suggestion.birthPlaceNote ? ` · ${suggestion.birthPlaceNote}` : ""}`;
    const chips = $("birthPlaceAlternatives"); chips.replaceChildren();
    (suggestion.birthPlaceAlternatives || []).forEach((candidate) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "chip";
      button.textContent = `${candidate.value} (${Math.round(Number(candidate.confidence || 0) * 100)}%)`;
      button.addEventListener("click", () => { $("finalBirthPlace").value = candidate.value; }); chips.appendChild(button);
    });
    $("previewBirthDate").textContent = formatDateId(raw.birthDate); $("originalAddress").textContent = raw.address;
    $("finalAddress").value = suggestion.address || raw.address;
    const addressConfidence = Math.round(Number(suggestion.addressConfidence || 0) * 100);
    $("addressMeta").textContent = `Confidence AI ${addressConfidence}%${suggestion.addressNote ? ` · ${suggestion.addressNote}` : ""}`;
    $("previewMotherName").textContent = raw.motherName; $("previewShirtSize").textContent = raw.shirtSize;
    $("previewBank").textContent = raw.bankPending ? "Rekening menyusul" : `${raw.bankName} · ${raw.accountNumber} · a.n. ${raw.accountHolder}`;
  }

  async function handleSubmit() {
    if (!previewState) return showBox($("previewStatus"), "Buat preview terlebih dahulu.", "error");
    const finalBirthPlace = $("finalBirthPlace").value.trim(); const finalAddress = $("finalAddress").value.trim();
    if (finalBirthPlace.length < 2) return showBox($("previewStatus"), "Tempat lahir hasil pemeriksaan tidak valid.", "error");
    if (finalAddress.length < 8) return showBox($("previewStatus"), "Alamat hasil pemeriksaan tidak valid.", "error");
    const payload = { ...previewState.raw, finalBirthPlace, finalAddress, birthPlaceConfidence: Number(previewState.suggestion.birthPlaceConfidence || 0), addressConfidence: Number(previewState.suggestion.addressConfidence || 0), aiNote: previewState.suggestion.addressNote || "" };
    setLoading($("submitButton"), true, "Mengirim..."); $("backButton").disabled = true; showBox($("previewStatus"), "Menyimpan pendaftaran...", "info");
    try {
      const response = await bridgeRequest("submit", payload);
      if (!response.success) throw new Error(response.message || "Pendaftaran gagal.");
      renderSuccess(response, payload.name);
    } catch (error) { showBox($("previewStatus"), error.message || String(error), "error"); $("backButton").disabled = false; setLoading($("submitButton"), false, "Kirim Pendaftaran"); }
  }

  function renderSuccess(response, name) {
    $("formSection").classList.add("hidden"); $("previewSection").classList.add("hidden"); $("successSection").classList.remove("hidden");
    $("successSummary").textContent = `${name}, pendaftaran Anda berhasil disimpan.`; $("successNumber").textContent = response.number;
    $("successClassCode").textContent = response.classCode; $("successVoucher").textContent = response.voucher;
    $("successSection").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function backToEdit() { $("previewSection").classList.add("hidden"); $("formSection").scrollIntoView({ behavior: "smooth", block: "start" }); }

  function bridgeRequest(action, payload) {
    return new Promise((resolve, reject) => {
      const requestId = makeRequestId(); const form = document.createElement("form"); const timeoutMs = Number(cfg.requestTimeoutMs || 45000);
      form.method = "POST"; form.action = cfg.backendUrl; form.target = "apiBridgeFrame"; form.style.display = "none";
      const values = { 
  action, 
  requestId, 
  frontendOrigin: window.location.origin, 
  ...payload 
};

console.log("DATA KIRIM:", values);
      Object.entries(values).forEach(([key, value]) => { const input = document.createElement("input"); input.type = "hidden"; input.name = key; input.value = typeof value === "boolean" ? String(value) : String(value ?? ""); form.appendChild(input); });
      const timer = window.setTimeout(() => { pendingRequests.delete(requestId); reject(new Error("Backend tidak merespons. Periksa URL Apps Script, deployment, ALLOWED_FRONTEND_ORIGINS, atau koneksi internet.")); }, timeoutMs);
      pendingRequests.set(requestId, { resolve: (data) => { clearTimeout(timer); resolve(data); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      let bridgeFrame = document.getElementById("apiBridgeFrame");
      if (!bridgeFrame) {
        bridgeFrame = document.createElement("iframe");
        bridgeFrame.id = "apiBridgeFrame";
        bridgeFrame.name = "apiBridgeFrame";
        bridgeFrame.style.display = "none";
        document.body.appendChild(bridgeFrame);
      }

      document.body.appendChild(form);
      console.log("POST BRIDGE:", values);
      form.submit();

      setTimeout(() => form.remove(), 3000);
    });
  }

  function handleBridgeMessage(event) {
    let trusted = false;
    try { const host = new URL(event.origin).hostname; trusted = host === "script.google.com" || host.endsWith("script.googleusercontent.com"); } catch (_) {}
    if (!trusted) return;
    const data = event.data; if (!data || data.source !== "anggota-registration-api" || !data.requestId) return;
    const pending = pendingRequests.get(data.requestId); if (!pending) return; pendingRequests.delete(data.requestId); pending.resolve(data);
  }

  function makeRequestId() { return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function setLoading(button, loading, label) { button.disabled = loading; button.textContent = label; }
  function showBox(element, message, type) { element.className = `alert alert-${type}`; element.textContent = message; element.classList.remove("hidden"); }
  function formatDateId(isoDate) { const parts = String(isoDate).split("-"); return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : isoDate; }
})();
