const CONFIG = Object.freeze({
  GROQ_MODEL: 'openai/gpt-oss-20b',
  FIRESTORE_DATABASE: '(default)',
  EXPORT_HEADER_ROW: 3,
  EXPORT_DATA_ROW: 4
});

const MASTER_PLACES = [
  ['Subang', ['Subng','Subangg']], ['Bandung', ['Bndung','Bandng']], ['Bandar Lampung', ['Bndar Lampung','Bandar Lmpung']],
  ['Indramayu', ['Indramyu','Indramay']], ['Cirebon', ['Crbn','Cirebn']], ['Jakarta', ['Jkarta','Jakrta']],
  ['Bogor', ['Bogr']], ['Bekasi', ['Beksi']], ['Depok', ['Depk']], ['Tangerang', ['Tanggerang','Tngerang']],
  ['Karawang', ['Krawang','Karwng']], ['Purwakarta', ['Purwakrta','Purwkarta']], ['Sumedang', ['Sumdang']],
  ['Majalengka', ['Majlengka']], ['Garut', ['Grut']], ['Tasikmalaya', ['Tasik','Tskmalaya']], ['Ciamis', ['Cmis']],
  ['Kuningan', ['Kuningn']], ['Sukabumi', ['Sukbumi']], ['Serang', ['Srng']]
];

/* ========================= SETUP ========================= */
function setupProject() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) {
    props.setProperty('SPREADSHEET_ID', ss.getId());
    try { ss.setSpreadsheetTimeZone('Asia/Jakarta'); } catch (_) {}
  }
  if (!props.getProperty('ALLOWED_FRONTEND_ORIGINS')) {
    props.setProperty('ALLOWED_FRONTEND_ORIGINS', 'http://localhost:5500,http://127.0.0.1:5500');
  }
  Logger.log('Isi Script Properties berikut sebelum deploy:');
  Logger.log('FIREBASE_PROJECT_ID, FIREBASE_WEB_API_KEY, GROQ_API_KEY, ALLOWED_FRONTEND_ORIGINS');
  Logger.log('SPREADSHEET_ID otomatis terisi jika script terikat ke Google Sheet.');
}

function diagnostic() {
  const p = PropertiesService.getScriptProperties();
  Logger.log(JSON.stringify({
    firebaseProjectId: p.getProperty('FIREBASE_PROJECT_ID') || '',
    firebaseWebApiKeyConfigured: Boolean(p.getProperty('FIREBASE_WEB_API_KEY')),
    groqConfigured: Boolean(p.getProperty('GROQ_API_KEY')),
    spreadsheetConfigured: Boolean(p.getProperty('SPREADSHEET_ID')),
    allowedFrontendOrigins: p.getProperty('ALLOWED_FRONTEND_ORIGINS') || '',
    webAppUrl: ScriptApp.getService().getUrl() || ''
  }, null, 2));
}

/* ========================= WEB APP ========================= */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    service: 'anggota-registration-api',
    message: 'Backend Firebase + Apps Script aktif.'
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  console.log("=== POST MASUK ===");
  console.log(JSON.stringify(e));

  if (!e || !e.parameter) {
    return bridgeResponse_({
      source:'anggota-registration-api',
      requestId:Utilities.getUuid(),
      success:false,
      message:'POST kosong'
    }, '*');
  }

  const requestId = cleanText_(e.parameter.requestId) || Utilities.getUuid();
  const requestedOrigin = cleanText_(e.parameter.frontendOrigin);

  try {
    const action = cleanText_(e.parameter.action);
    let result;

    if (action === 'classInfo') result = classInfo_(e.parameter);
    else if (action === 'preview') result = previewRegistration_(e.parameter);
    else if (action === 'submit') result = saveRegistration_(e.parameter);
    else if (action === 'export') result = exportToSpreadsheet_(e.parameter);
    else throw new Error('Action tidak dikenal: ' + action);

    result.source='anggota-registration-api';
    result.requestId=requestId;

    return bridgeResponse_(result, requestedOrigin || '*');

  } catch(error) {
    return bridgeResponse_({
      source:'anggota-registration-api',
      requestId,
      success:false,
      message:error.message || 'Backend error'
    }, requestedOrigin || '*');
  }
}

/* ========================= CLASS INFO ========================= */
function classInfo_(data) {
  const code = validateClassCode_(data.classCode);
  const classDoc = firestoreGetDocument_(['classes', code]);
  if (!classDoc) throw new Error('Kelas tidak ditemukan. Periksa link pendaftaran.');
  const cls = firestoreDocumentToObject_(classDoc);
  const available = firestoreRunQuery_(['classes', code], {
    from:[{collectionId:'vouchers'}],
    where:{fieldFilter:{field:{fieldPath:'status'},op:'EQUAL',value:{stringValue:'available'}}}
  });
  return { success:true, classData:{ code:cls.code || code, name:cls.name || code, status:cls.status || 'closed', availableVouchers:available.length } };
}

/* ========================= PREVIEW ========================= */
function previewRegistration_(data) {
  const input = validateRegistrationInput_(data, false);
  const localPlace = suggestPlace_(input.birthPlace);
  let aiResult, aiAvailable = true;
  try { aiResult = normalizeWithGroq_(input.birthPlace, input.address); }
  catch (error) {
    console.warn('Groq preview fallback: ' + error);
    aiAvailable = false;
    aiResult = { correctedBirthPlace:input.birthPlace, birthPlaceConfidence:0, correctedAddress:input.address, addressConfidence:0,
      note:'AI sementara tidak tersedia. Teks asli dipertahankan dan tetap dapat diperiksa manual.' };
  }
  const placeDecision = choosePlaceSuggestion_(input.birthPlace, localPlace, aiResult);
  let correctedAddress = cleanText_(aiResult.correctedAddress) || input.address;
  let addressConfidence = clamp01_(Number(aiResult.addressConfidence || 0));
  if (!isSafeAddressCorrection_(input.address, correctedAddress)) { correctedAddress=input.address; addressConfidence=0; }
  return { success:true, aiAvailable, suggestion:{
    birthPlace:placeDecision.value, birthPlaceConfidence:round3_(placeDecision.confidence), birthPlaceSource:placeDecision.source,
    birthPlaceAlternatives:localPlace.alternatives, birthPlaceNote:placeDecision.note,
    address:correctedAddress, addressConfidence:round3_(addressConfidence), addressNote:cleanText_(aiResult.note)
  }};
}

/* ========================= SUBMIT FIRESTORE TRANSACTION ========================= */
function saveRegistration_(data) {
  const input = validateRegistrationInput_(data, true);
  if (extractNumbers_(input.address) !== extractNumbers_(input.finalAddress)) {
    throw new Error('Angka pada alamat hasil preview berbeda dari input asli. Kembali edit alamat asli.');
  }
  if (!isReasonableTextEdit_(input.address, input.finalAddress)) {
    throw new Error('Perubahan alamat terlalu besar. Kembali edit alamat asli agar data tidak berubah secara tidak sengaja.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return registerInFirestoreTransaction_(input, data); }
  finally { lock.releaseLock(); }
}

function registerInFirestoreTransaction_(input, rawData) {
  const projectId = getRequiredProperty_('FIREBASE_PROJECT_ID');
  const dbRoot = firestoreDatabaseRoot_();
  const transaction = firestoreRequest_('post', dbRoot + '/documents:beginTransaction', {}).transaction;
  if (!transaction) throw new Error('Gagal memulai transaksi Firestore.');

  try {
    const classDoc = firestoreGetDocument_(['classes', input.classCode], transaction);
    if (!classDoc) throw new Error('Kelas tidak ditemukan.');
    const cls = firestoreDocumentToObject_(classDoc);
    if (cls.status !== 'active') throw new Error('Pendaftaran kelas ini sedang ditutup oleh admin.');

    const existingMember = firestoreGetDocument_(['members', input.nik], transaction);
    if (existingMember) throw new Error('NIK tersebut sudah pernah terdaftar. Jangan mengirim pendaftaran dua kali.');

    const vouchers = firestoreRunQuery_(['classes', input.classCode], {
      from:[{collectionId:'vouchers'}],
      where:{fieldFilter:{field:{fieldPath:'status'},op:'EQUAL',value:{stringValue:'available'}}}
    }, transaction);
    if (!vouchers.length) throw new Error('Voucher untuk kelas ini sudah habis. Silakan hubungi admin.');
    vouchers.sort(function(a,b){
      const av=String(firestoreDocumentToObject_(a).code || a.name.split('/').pop());
      const bv=String(firestoreDocumentToObject_(b).code || b.name.split('/').pop());
      return av.localeCompare(bv, undefined, {numeric:true});
    });

    const voucherDoc = vouchers[0];
    const voucher = firestoreDocumentToObject_(voucherDoc);
    const nextNumber = Number(cls.registrationSeq || 0) + 1;
    const now = new Date().toISOString();
    const resourceRoot = firestoreResourceRoot_();
    const memberName = resourceRoot + '/documents/members/' + input.nik;
    const className = resourceRoot + '/documents/classes/' + input.classCode;

    const memberFields = encodeFields_({
      nik:input.nik, name:input.name, phone:input.phone || "", email:input.email || "", birthPlace:input.finalBirthPlace, birthDate:input.birthDate, address:input.finalAddress,
      motherName:input.motherName, bankPending:input.bankPending, accountNumber:input.bankPending ? '' : input.accountNumber,
      bankName:input.bankPending ? 'Menyusul' : input.bankName, accountHolder:input.bankPending ? '' : input.accountHolder,
      shirtSize:input.shirtSize, classId:input.classCode, voucherCode:voucher.code || voucherDoc.name.split('/').pop(),
      registrationNumber:nextNumber, createdAt:new Date(), updatedAt:new Date(),
      originalBirthPlace:input.birthPlace, originalAddress:input.address,
      birthPlaceConfidence:clamp01_(Number(rawData.birthPlaceConfidence || 0)), addressConfidence:clamp01_(Number(rawData.addressConfidence || 0)),
      aiNote:cleanText_(rawData.aiNote)
    });

    const writes = [
      { update:{name:memberName, fields:memberFields}, currentDocument:{exists:false} },
      { update:{name:voucherDoc.name, fields:encodeFields_({status:'assigned',memberNik:input.nik,assignedAt:new Date()})}, updateMask:{fieldPaths:['status','memberNik','assignedAt']} },
      { update:{name:className, fields:encodeFields_({registrationSeq:nextNumber,updatedAt:new Date()})}, updateMask:{fieldPaths:['registrationSeq','updatedAt']} }
    ];

    firestoreRequest_('post', dbRoot + '/documents:commit', { writes, transaction });
    return { success:true, message:'Pendaftaran berhasil disimpan.', number:nextNumber, classCode:input.classCode,
      voucher:voucher.code || voucherDoc.name.split('/').pop() };
  } catch (error) {
    try { firestoreRequest_('post', dbRoot + '/documents:rollback', {transaction}); } catch (_) {}
    throw error;
  }
}

/* ========================= EXPORT ========================= */
function exportToSpreadsheet_(data) {
  const admin = verifyFirebaseAdmin_(cleanText_(data.idToken));
  if (!admin) throw new Error('Sesi admin tidak valid. Silakan login ulang.');
  const classCode = cleanText_(data.classCode).toUpperCase();
  let docs;
  if (classCode) {
    validateClassCode_(classCode);
    docs = firestoreRunQuery_([], { from:[{collectionId:'members'}], where:{fieldFilter:{field:{fieldPath:'classId'},op:'EQUAL',value:{stringValue:classCode}}} });
  } else {
    docs = firestoreRunQuery_([], { from:[{collectionId:'members'}] });
  }

  const members = docs.map(firestoreDocumentToObject_).sort(function(a,b){
    const ca=String(a.classId||''), cb=String(b.classId||'');
    if (ca !== cb) return ca.localeCompare(cb);
    return Number(a.registrationNumber||0)-Number(b.registrationNumber||0);
  });

  const ss = getSpreadsheet_();
  const safeName = classCode ? ('Export ' + classCode) : 'Export Semua';
  let sheet = ss.getSheetByName(safeName);
  if (!sheet) sheet = ss.insertSheet(safeName);
  sheet.clear({contentsOnly:false});

  sheet.getRange('A1').setValue('Kode Kelas').setFontWeight('bold').setBackground('#E8F0FE');
  sheet.getRange('B1').setValue(classCode || 'SEMUA KELAS').setFontWeight('bold').setBackground('#E8F0FE');
  sheet.getRange('D1').setValue('Waktu Export').setFontWeight('bold');
  sheet.getRange('E1').setValue(new Date()).setNumberFormat('dd/MM/yyyy HH:mm:ss');

  const headers = [['NO.','NIK','NAMA','TEMPAT LAHIR','TGL LAHIR','HANDPHONE','EMAIL','ALAMAT LENGKAP','NAMA IBU','Nomor Rekening','Nama BANK','Atas Nama Bank','Ukuran Baju','Kode Voucher','Kode Kelas']];
  sheet.getRange(CONFIG.EXPORT_HEADER_ROW,1,1,headers[0].length).setValues(headers).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true).setBackground('#D9EAF7');

  if (members.length) {
    const rows = members.map(function(m,i){return [
      m.registrationNumber || (i+1), String(m.nik||''), m.name||'', m.birthPlace||'', isoToDate_(m.birthDate),
      m.phone||m.handphone||'', m.email||'', m.address||'', m.motherName||'', m.accountNumber||'', m.bankName||'', m.accountHolder||'', m.shirtSize||'', m.voucherCode||'', m.classId||''
    ];});
    sheet.getRange(CONFIG.EXPORT_DATA_ROW,1,rows.length,headers[0].length).setValues(rows);
    sheet.getRange(CONFIG.EXPORT_DATA_ROW,2,rows.length,1).setNumberFormat('@');
    sheet.getRange(CONFIG.EXPORT_DATA_ROW,8,rows.length,1).setNumberFormat('@');
    sheet.getRange(CONFIG.EXPORT_DATA_ROW,5,rows.length,1).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(CONFIG.EXPORT_DATA_ROW,6,rows.length,1).setWrap(true);
  }

  const widths=[60,150,190,140,110,360,170,150,125,185,105,120,120];
  widths.forEach(function(w,i){sheet.setColumnWidth(i+1,w);});
  sheet.setFrozenRows(CONFIG.EXPORT_HEADER_ROW);
  SpreadsheetApp.flush();
  return { success:true, rowCount:members.length, spreadsheetUrl:ss.getUrl(), sheetName:safeName };
}

function verifyFirebaseAdmin_(idToken) {
  if (!idToken) return null;
  const apiKey = getRequiredProperty_('FIREBASE_WEB_API_KEY');
  const response = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey), {
    method:'post', contentType:'application/json', payload:JSON.stringify({idToken}), muteHttpExceptions:true
  });
  if (response.getResponseCode() !== 200) return null;
  const json = JSON.parse(response.getContentText());
  const user = json.users && json.users[0];
  if (!user || !user.localId) return null;
  const adminDoc = firestoreGetDocument_(['admins', user.localId]);
  if (!adminDoc) return null;
  const admin = firestoreDocumentToObject_(adminDoc);
  if (admin.role !== 'admin' || admin.active !== true) return null;
  return {uid:user.localId,email:user.email||'',admin};
}

/* ========================= VALIDATION ========================= */
function validateRegistrationInput_(data, finalSubmission) {
  const classCode = validateClassCode_(data.classCode);
  const nik = cleanText_(data.nik);
  const name=cleanText_(data.name), phone=cleanText_(data.phone), email=cleanText_(data.email), birthPlace=cleanText_(data.birthPlace), birthDate=cleanText_(data.birthDate), address=cleanText_(data.address), motherName=cleanText_(data.motherName), shirtSize=cleanText_(data.shirtSize).toUpperCase();
  const bankPending = ['true','on','1'].indexOf(String(data.bankPending).toLowerCase()) !== -1;
  if (!/^\d{16}$/.test(nik)) throw new Error('NIK harus terdiri dari tepat 16 digit angka.');
  if (name.length<2||name.length>100) throw new Error('Nama lengkap wajib diisi dengan benar.');
  if (birthPlace.length<2||birthPlace.length>80) throw new Error('Tempat lahir wajib diisi dengan benar.');
  if (!isValidIsoDate_(birthDate)) throw new Error('Tanggal lahir tidak valid.');
  if (parseIsoDate_(birthDate)>new Date()) throw new Error('Tanggal lahir tidak boleh berada di masa depan.');
  if (address.length<8||address.length>500) throw new Error('Alamat lengkap wajib diisi dengan benar.');
  if (motherName.length<2||motherName.length>100) throw new Error('Nama ibu wajib diisi dengan benar.');
  if (['S','M','L','XL','XXL','XXXL'].indexOf(shirtSize)===-1) throw new Error('Ukuran baju tidak valid.');
  let accountNumber='',bankName='',accountHolder='';
  if (!bankPending) {
    accountNumber=cleanText_(data.accountNumber).replace(/\s+/g,''); bankName=cleanText_(data.bankName); accountHolder=cleanText_(data.accountHolder);
    if (!/^\d{5,30}$/.test(accountNumber)) throw new Error('Nomor rekening harus 5 sampai 30 digit angka.');
    if (!bankName||bankName.length>80) throw new Error('Nama bank wajib diisi.');
    if (accountHolder.length<2||accountHolder.length>100) throw new Error('Atas nama bank wajib diisi.');
  }
  const finalBirthPlace = finalSubmission ? cleanText_(data.finalBirthPlace) : birthPlace;
  const finalAddress = finalSubmission ? cleanText_(data.finalAddress) : address;
  if (finalSubmission && (finalBirthPlace.length<2||finalBirthPlace.length>80)) throw new Error('Tempat lahir hasil preview tidak valid.');
  if (finalSubmission && (finalAddress.length<8||finalAddress.length>500)) throw new Error('Alamat hasil preview tidak valid.');
  return {classCode,nik,name,phone,email,birthPlace,birthDate,address,motherName,bankPending,accountNumber,bankName,accountHolder,shirtSize,finalBirthPlace,finalAddress};
}

function validateClassCode_(value) {
  const code = cleanText_(value).toUpperCase();
  if (!/^[A-Z0-9_-]{4,20}$/.test(code)) throw new Error('Kode kelas tidak valid.');
  return code;
}

/* ========================= FIRESTORE REST ========================= */
function firestoreResourceRoot_() {
  return 'projects/' + getRequiredProperty_('FIREBASE_PROJECT_ID') + '/databases/' + CONFIG.FIRESTORE_DATABASE;
}
function firestoreDatabaseRoot_() {
  return 'https://firestore.googleapis.com/v1/' + firestoreResourceRoot_();
}
function firestoreDocumentsRoot_(){ return firestoreDatabaseRoot_() + '/documents'; }
function firestorePath_(segments){ return segments.map(function(s){return encodeURIComponent(String(s));}).join('/'); }

function firestoreRequest_(method, url, body) {
  const options = { method:method, muteHttpExceptions:true, headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()} };
  if (body !== undefined) { options.contentType='application/json'; options.payload=JSON.stringify(body); }
  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    let msg=text; try { const j=JSON.parse(text); msg=j.error && j.error.message ? j.error.message : text; } catch(_){}
    const err = new Error('Firestore API ' + status + ': ' + msg); err.status=status; throw err;
  }
  return text ? JSON.parse(text) : {};
}

function firestoreGetDocument_(segments, transaction) {
  let url = firestoreDocumentsRoot_() + '/' + firestorePath_(segments);
  if (transaction) url += '?transaction=' + encodeURIComponent(transaction);
  try { return firestoreRequest_('get', url); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

function firestoreRunQuery_(parentSegments, structuredQuery, transaction) {
  let parent = firestoreDocumentsRoot_();
  if (parentSegments && parentSegments.length) parent += '/' + firestorePath_(parentSegments);
  const body = { structuredQuery:structuredQuery };
  if (transaction) body.transaction = transaction;
  const rows = firestoreRequest_('post', parent + ':runQuery', body);
  return (rows || []).map(function(r){return r.document;}).filter(Boolean);
}

function encodeFields_(obj) {
  const fields={}; Object.keys(obj).forEach(function(k){fields[k]=firestoreValue_(obj[k]);}); return fields;
}
function firestoreValue_(value) {
  if (value === null || value === undefined) return {nullValue:null};
  if (value instanceof Date) return {timestampValue:value.toISOString()};
  if (typeof value === 'boolean') return {booleanValue:value};
  if (typeof value === 'number') return Number.isInteger(value) ? {integerValue:String(value)} : {doubleValue:value};
  if (Array.isArray(value)) return {arrayValue:{values:value.map(firestoreValue_)}};
  if (typeof value === 'object') return {mapValue:{fields:encodeFields_(value)}};
  return {stringValue:String(value)};
}
function firestoreDocumentToObject_(doc) {
  const out={}; const fields=doc && doc.fields ? doc.fields : {};
  Object.keys(fields).forEach(function(k){out[k]=decodeFirestoreValue_(fields[k]);});
  if (doc && doc.name) out.__name=doc.name; return out;
}
function decodeFirestoreValue_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values||[]).map(decodeFirestoreValue_);
  if ('mapValue' in v) { const o={}; const f=v.mapValue.fields||{}; Object.keys(f).forEach(function(k){o[k]=decodeFirestoreValue_(f[k]);}); return o; }
  return null;
}

/* ========================= GROQ ========================= */
function normalizeWithGroq_(birthPlace,address) {
  const apiKey=getRequiredProperty_('GROQ_API_KEY');
  const systemPrompt=[
    'Anda adalah mesin normalisasi teks formulir keanggotaan Indonesia.',
    'Anda hanya boleh memperbaiki TEMPAT LAHIR dan ALAMAT LENGKAP.',
    'Koreksi typo, kapitalisasi, singkatan administratif, dan huruf yang hilang jika konteks sangat kuat.',
    'Jangan mengarang wilayah jika ada lebih dari satu interpretasi yang masuk akal.',
    'Jangan meminta atau memproses NIK, nama orang, nama ibu, tanggal lahir, data bank, nomor rekening, atau data finansial.'
  ].join(' ');
  const normalizedAddressInput=normalizeAdministrativeAbbreviations_(address);
  const userPrompt=[
    'ATURAN TEMPAT LAHIR:','- Koreksi hanya typo yang jelas.','- Jika ragu, pertahankan input asli.','',
    'ATURAN ALAMAT:','- Perbaiki typo, kapitalisasi, spasi, tanda baca, dan singkatan administratif.',
    '- DILARANG mengubah, menghapus, menambah, atau menukar angka.','- DILARANG mengarang nomor rumah, RT/RW, blok, kode pos, atau bagian alamat yang tidak tersirat.',
    '- Pertahankan bagian yang ambigu.','', 'TEMPAT LAHIR ASLI:',birthPlace,'','ALAMAT ASLI:',address,'','ALAMAT SETELAH NORMALISASI SINGKATAN DASAR:',normalizedAddressInput
  ].join('\n');
  const schema={type:'object',properties:{correctedBirthPlace:{type:'string'},birthPlaceConfidence:{type:'number',minimum:0,maximum:1},correctedAddress:{type:'string'},addressConfidence:{type:'number',minimum:0,maximum:1},note:{type:'string'}},required:['correctedBirthPlace','birthPlaceConfidence','correctedAddress','addressConfidence','note'],additionalProperties:false};
  const payload={model:CONFIG.GROQ_MODEL,messages:[{role:'system',content:systemPrompt},{role:'user',content:userPrompt}],reasoning_effort:'low',response_format:{type:'json_schema',json_schema:{name:'registration_cleanup',strict:true,schema:schema}}};
  const response=UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+apiKey},payload:JSON.stringify(payload),muteHttpExceptions:true});
  const status=response.getResponseCode(), body=response.getContentText();
  if(status<200||status>=300){if(status===429)throw new Error('Batas penggunaan Groq sedang tercapai.');throw new Error('Groq API gagal dengan status '+status+'.');}
  const json=JSON.parse(body); const content=json&&json.choices&&json.choices[0]&&json.choices[0].message&&json.choices[0].message.content;
  if(!content)throw new Error('Respons Groq kosong.');
  const result=JSON.parse(content); let correctedAddress=cleanText_(result.correctedAddress)||address;
  if(!isSafeAddressCorrection_(address,correctedAddress)) correctedAddress=address;
  return {correctedBirthPlace:cleanText_(result.correctedBirthPlace)||birthPlace,birthPlaceConfidence:clamp01_(Number(result.birthPlaceConfidence||0)),correctedAddress:correctedAddress,addressConfidence:correctedAddress===address?0:clamp01_(Number(result.addressConfidence||0)),note:cleanText_(result.note)||'Periksa kembali hasil sebelum mengirim.'};
}

/* ========================= PLACE FUZZY ========================= */
function suggestPlace_(input) {
  const inputNorm=normalizeForMatch_(input), scored=[];
  MASTER_PLACES.forEach(function(item){const canonical=item[0], aliases=item[1]||[];let best=0;[canonical].concat(aliases).forEach(function(c){best=Math.max(best,similarity_(inputNorm,normalizeForMatch_(c)));});scored.push({value:canonical,confidence:best});});
  scored.sort(function(a,b){return b.confidence-a.confidence;}); const top=scored.slice(0,5), best=top[0]||{value:input,confidence:0};
  return {suggestion:best.confidence>=0.62?best.value:input,confidence:round3_(best.confidence),alternatives:top.map(function(i){return{value:i.value,confidence:round3_(i.confidence)};}),note:best.confidence>=0.86?'Kecocokan kuat dengan master tempat lahir.':best.confidence>=0.62?'Ada kandidat yang mirip. Periksa sebelum mengirim.':'Tidak ada kecocokan kuat di master.'};
}
function choosePlaceSuggestion_(original,localPlace,aiResult){
  if(localPlace.confidence>=0.86)return{value:localPlace.suggestion,confidence:localPlace.confidence,source:'Master tempat lahir',note:localPlace.note};
  const aiValue=cleanText_(aiResult.correctedBirthPlace), aiConfidence=clamp01_(Number(aiResult.birthPlaceConfidence||0));
  if(aiValue&&aiConfidence>=0.72&&isPlausiblePlaceCorrection_(original,aiValue))return{value:aiValue,confidence:aiConfidence,source:'Groq AI',note:'Saran AI. Tetap periksa sebelum mengirim.'};
  if(localPlace.confidence>=0.62)return{value:localPlace.suggestion,confidence:localPlace.confidence,source:'Master tempat lahir',note:localPlace.note};
  return{value:original,confidence:0,source:'Input asli',note:'Tidak ada koreksi yang cukup meyakinkan.'};
}

/* ========================= BRIDGE / ORIGIN ========================= */
function bridgeResponse_(payload,targetOrigin){
  const safePayload=JSON.stringify(payload).replace(/</g,'\\u003c').replace(/>/g,'\\u003e'); const safeOrigin=JSON.stringify(targetOrigin||'*');
  const html=['<!doctype html>','<html><head><meta charset="utf-8"></head><body>','<script>','(function(){','var data='+safePayload+';','var targetOrigin='+safeOrigin+';','if(window.top){window.top.postMessage(data,targetOrigin);}else if(window.parent){window.parent.postMessage(data,targetOrigin);}','})();','<\\/script>','</body></html>'].join('');
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function isOriginAllowed_(origin){if(!origin)return false;return getAllowedOrigins_().indexOf(origin)!==-1;}
function getAllowedOrigins_(){return (PropertiesService.getScriptProperties().getProperty('ALLOWED_FRONTEND_ORIGINS')||'').split(',').map(cleanText_).filter(Boolean);}

/* ========================= UTILITIES ========================= */
function normalizeAdministrativeAbbreviations_(value){return cleanText_(value).replace(/\bkp[\.,]?\s*/gi,'Kp. ').replace(/\bdsn[\.,]?\s*/gi,'Dsn. ').replace(/\bds[\.,]?\s*/gi,'Ds. ').replace(/\bkc[\.,]?\s*/gi,'Kec. ').replace(/\bkec[\.,]?\s*/gi,'Kec. ').replace(/\bkab[\.,]?\s*/gi,'Kab. ').replace(/\brt[\.,]?\s*/gi,'RT ').replace(/\brw[\.,]?\s*/gi,'RW ').replace(/\bbrt\b/gi,'Barat').replace(/\btgh\b/gi,'Tengah').replace(/\btim\b/gi,'Timur').replace(/\butr\b/gi,'Utara').replace(/\bsel\b/gi,'Selatan').replace(/\s+/g,' ').trim();}
function isSafeAddressCorrection_(original,corrected){original=cleanText_(original);corrected=cleanText_(corrected);if(!corrected)return false;if(extractNumbers_(original)!==extractNumbers_(corrected))return false;return isReasonableTextEdit_(original,corrected);}
function isReasonableTextEdit_(original,edited){const ratio=cleanText_(edited).length/Math.max(cleanText_(original).length,1);return ratio>=0.65&&ratio<=1.55;}
function isPlausiblePlaceCorrection_(original,corrected){const a=normalizeForMatch_(original),b=normalizeForMatch_(corrected);if(!a||!b)return false;if(a===b)return true;return similarity_(a,b)>=0.55;}
function normalizeForMatch_(value){return cleanText_(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();}
function similarity_(a,b){a=String(a||'');b=String(b||'');if(a===b)return 1;if(!a||!b)return 0;const d=levenshtein_(a,b);return Math.max(0,1-d/Math.max(a.length,b.length));}
function levenshtein_(a,b){const n=b.length,dp=new Array(n+1);for(let j=0;j<=n;j++)dp[j]=j;for(let i=1;i<=a.length;i++){let prev=dp[0];dp[0]=i;for(let j=1;j<=n;j++){const temp=dp[j],cost=a[i-1]===b[j-1]?0:1;dp[j]=Math.min(dp[j]+1,dp[j-1]+1,prev+cost);prev=temp;}}return dp[n];}
function extractNumbers_(value){return(String(value||'').match(/\d+/g)||[]).join('|');}
function cleanText_(value){return String(value==null?'':value).replace(/\s+/g,' ').trim();}
function clamp01_(number){if(!Number.isFinite(number))return 0;return Math.max(0,Math.min(1,number));}
function round3_(number){return Math.round(Number(number||0)*1000)/1000;}
function isValidIsoDate_(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;try{const date=parseIsoDate_(value);return Utilities.formatDate(date,'Asia/Jakarta','yyyy-MM-dd')===value;}catch(_){return false;}}
function parseIsoDate_(value){return Utilities.parseDate(value,'Asia/Jakarta','yyyy-MM-dd');}
function isoToDate_(value){try{return parseIsoDate_(String(value||''));}catch(_){return value||'';}}
function getRequiredProperty_(name){const value=PropertiesService.getScriptProperties().getProperty(name);if(!value)throw new Error('Script Property '+name+' belum dikonfigurasi.');return value;}
function getSpreadsheet_(){const id=getRequiredProperty_('SPREADSHEET_ID');return SpreadsheetApp.openById(id);}
