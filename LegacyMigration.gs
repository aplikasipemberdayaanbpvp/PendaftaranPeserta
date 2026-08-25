/*
  MIGRASI SATU KALI DARI SHEET LAMA KE FIRESTORE

  Sebelum menjalankan:
  1. Tambahkan kolom NIK pada baris header (baris 3). Posisi kolom bebas.
  2. Pastikan semua anggota lama memiliki NIK 16 digit.
  3. Pastikan kelas sudah dibuat di Admin Panel / Firestore.
  4. Set Script Property LEGACY_SHEET_NAME jika nama sheet bukan "Data Anggota".
  5. Kode kelas dibaca dari B1, atau set LEGACY_CLASS_CODE sebagai override.

  Fungsi ini tidak menghapus sheet lama.
*/

function migrateLegacySheetToFirestore() {
  const props = PropertiesService.getScriptProperties();
  const sheetName = props.getProperty('LEGACY_SHEET_NAME') || 'Data Anggota';
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet legacy "' + sheetName + '" tidak ditemukan.');

  const headerRow = 3;
  const dataStartRow = 4;
  const lastColumn = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  if (lastRow < dataStartRow) throw new Error('Tidak ada data untuk dimigrasikan.');

  const headers = sheet.getRange(headerRow, 1, 1, lastColumn).getDisplayValues()[0];
  const map = buildLegacyHeaderMap_(headers);
  const required = ['nik','name','birthPlace','birthDate','address','motherName','shirtSize','voucherCode'];
  required.forEach(function(key){ if (map[key] == null) throw new Error('Kolom wajib tidak ditemukan: ' + key + '. Pastikan header NIK sudah ditambahkan.'); });

  const classCode = validateClassCode_(props.getProperty('LEGACY_CLASS_CODE') || sheet.getRange('B1').getDisplayValue());
  const classDoc = firestoreGetDocument_(['classes', classCode]);
  if (!classDoc) throw new Error('Kelas ' + classCode + ' belum ada di Firestore. Buat kelas dari admin terlebih dahulu.');

  const values = sheet.getRange(dataStartRow, 1, lastRow - dataStartRow + 1, lastColumn).getValues();
  const display = sheet.getRange(dataStartRow, 1, lastRow - dataStartRow + 1, lastColumn).getDisplayValues();
  let imported = 0, skipped = 0, maxSeq = Number(firestoreDocumentToObject_(classDoc).registrationSeq || 0);
  const errors = [];

  values.forEach(function(row, i) {
    const rowNumber = dataStartRow + i;
    try {
      const nik = cleanText_(display[i][map.nik]).replace(/\D/g, '');
      if (!/^\d{16}$/.test(nik)) throw new Error('NIK harus 16 digit.');
      if (firestoreGetDocument_(['members', nik])) { skipped++; return; }

      const voucherCode = cleanText_(display[i][map.voucherCode]).toUpperCase();
      if (!voucherCode) throw new Error('Kode voucher kosong.');

      const registrationNumber = legacyNumber_(row, display[i], map.number, imported + 1);
      maxSeq = Math.max(maxSeq, registrationNumber);
      const birthDate = legacyDateToIso_(row[map.birthDate], display[i][map.birthDate]);
      const bankName = map.bankName == null ? '' : cleanText_(display[i][map.bankName]);
      const bankPending = !bankName || bankName.toLowerCase() === 'menyusul';

      const member = {
        nik: nik,
        name: cleanText_(display[i][map.name]),
        birthPlace: cleanText_(display[i][map.birthPlace]),
        birthDate: birthDate,
        address: cleanText_(display[i][map.address]),
        motherName: cleanText_(display[i][map.motherName]),
        bankPending: bankPending,
        accountNumber: map.accountNumber == null ? '' : cleanText_(display[i][map.accountNumber]),
        bankName: bankPending ? 'Menyusul' : bankName,
        accountHolder: map.accountHolder == null ? '' : cleanText_(display[i][map.accountHolder]),
        shirtSize: cleanText_(display[i][map.shirtSize]).toUpperCase(),
        classId: classCode,
        voucherCode: voucherCode,
        registrationNumber: registrationNumber,
        createdAt: new Date(),
        updatedAt: new Date(),
        originalBirthPlace: cleanText_(display[i][map.birthPlace]),
        originalAddress: cleanText_(display[i][map.address]),
        birthPlaceConfidence: 0,
        addressConfidence: 0,
        aiNote: 'Migrasi dari Google Spreadsheet legacy.'
      };

      const voucherExisting = firestoreGetDocument_(['classes', classCode, 'vouchers', voucherCode]);
      if (voucherExisting) {
        const v = firestoreDocumentToObject_(voucherExisting);
        if (v.status === 'assigned' && v.memberNik && String(v.memberNik) !== nik) {
          throw new Error('Voucher ' + voucherCode + ' sudah terikat ke NIK lain.');
        }
      }

      const resourceRoot = firestoreResourceRoot_();
      const writes = [
        {
          update: { name: resourceRoot + '/documents/members/' + nik, fields: encodeFields_(member) },
          currentDocument: { exists: false }
        },
        {
          update: {
            name: resourceRoot + '/documents/classes/' + classCode + '/vouchers/' + voucherCode,
            fields: encodeFields_({code:voucherCode,status:'assigned',memberNik:nik,assignedAt:new Date(),createdAt:new Date()})
          }
        }
      ];
      firestoreRequest_('post', firestoreDatabaseRoot_() + '/documents:commit', {writes:writes});
      imported++;
    } catch (error) {
      errors.push('Baris ' + rowNumber + ': ' + (error.message || error));
    }
  });

  firestoreRequest_('post', firestoreDatabaseRoot_() + '/documents:commit', {writes:[{
    update:{name:firestoreResourceRoot_() + '/documents/classes/' + classCode,fields:encodeFields_({registrationSeq:maxSeq,updatedAt:new Date()})},
    updateMask:{fieldPaths:['registrationSeq','updatedAt']}
  }]});

  const report = {classCode:classCode, imported:imported, skippedExistingNik:skipped, errors:errors.length, errorDetails:errors.slice(0,50)};
  Logger.log(JSON.stringify(report,null,2));
  return report;
}

function buildLegacyHeaderMap_(headers) {
  const normalized = headers.map(function(h){return cleanText_(h).toLowerCase().replace(/[^a-z0-9]/g,'');});
  function find(names){for(let i=0;i<normalized.length;i++){if(names.indexOf(normalized[i])!==-1)return i;}return null;}
  return {
    number: find(['no','nomor']),
    nik: find(['nik']),
    name: find(['nama','namalengkap']),
    birthPlace: find(['tempatlahir']),
    birthDate: find(['tgllahir','tanggallahir']),
    address: find(['alamatlengkap','alamat']),
    motherName: find(['namaibu']),
    accountNumber: find(['nomorrekening','norekening']),
    bankName: find(['namabank','bank']),
    accountHolder: find(['atasnamabank','atasnama','pemilikrekening']),
    shirtSize: find(['ukuranbaju','sizebaju']),
    voucherCode: find(['kodevoucher','voucher'])
  };
}

function legacyDateToIso_(value, displayValue) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value,'Asia/Jakarta','yyyy-MM-dd');
  const text = cleanText_(displayValue);
  let m = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  throw new Error('Tanggal lahir tidak dapat dibaca: ' + text);
}

function legacyNumber_(row, displayRow, index, fallback) {
  if (index == null) return fallback;
  const n = Number(row[index] || displayRow[index]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
