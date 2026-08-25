# Keanggotaan — GitHub Pages + Firebase + Apps Script

Versi ini memindahkan **database utama dari Google Spreadsheet ke Cloud Firestore**. GitHub Pages hanya menjadi hosting HTML/CSS/JS. Apps Script tetap dipakai sebagai backend aman untuk preview Groq, submit pendaftaran publik, dan export Firestore ke Google Spreadsheet.

## Struktur

- `index.html` — form pendaftaran publik.
- `app.js` — logika form, preview, submit, kelas dari query `?kelas=...`.
- `styles.css` — tampilan form publik.
- `admin.html` — panel admin.
- `admin.css` — tampilan admin.
- `js/admin.js` — Firebase Auth + CRUD kelas/voucher/anggota + export.
- `js/firebase-config.js` — Firebase Web config (isi dari Firebase Console).
- `config.js` — URL deployment Apps Script.
- `Code.gs` — backend Apps Script baru.
- `appsscript.json` — OAuth scopes Apps Script, termasuk Firestore (`datastore`).
- `firestore.rules` — Security Rules Firestore.

## Model data Firestore

```text
classes/{classCode}
  code
  name
  status              active | closed
  registrationSeq
  createdAt
  updatedAt

classes/{classCode}/vouchers/{voucherCode}
  code
  status              available | assigned
  memberNik
  createdAt
  assignedAt

members/{nik}
  nik                  document ID / primary key
  name
  birthPlace
  birthDate
  address
  motherName
  accountNumber
  bankName
  accountHolder
  shirtSize
  classId
  voucherCode
  registrationNumber
  createdAt
  updatedAt

admins/{firebaseUid}
  name
  email
  role                 "admin"
  active               true
```

## 1. Buat Firebase project

1. Buka Firebase Console dan buat project.
2. Aktifkan **Cloud Firestore**.
3. Aktifkan **Authentication > Sign-in method > Email/Password**.
4. Tambahkan **Web App** pada project Firebase.
5. Salin Firebase Web config ke `js/firebase-config.js`.

Contoh bentuknya:

```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "project-id.firebaseapp.com",
  projectId: "project-id",
  storageBucket: "project-id.firebasestorage.app",
  messagingSenderId: "...",
  appId: "..."
};
```

Firebase Web config bukan service-account secret. **Jangan pernah** memasukkan service-account JSON, private key, atau `GROQ_API_KEY` ke GitHub.

## 2. Pasang Firestore Security Rules

Firebase Console > Firestore Database > Rules, lalu ganti dengan isi `firestore.rules` dan Publish.

Browser publik tidak mendapatkan akses ke `members` maupun `vouchers`. Panel admin hanya memperoleh akses setelah Firebase Auth + dokumen `admins/{uid}` valid.

## 3. Buat admin pertama

1. Firebase Console > Authentication > Users > Add user.
2. Buat email/password admin.
3. Salin **UID** user tersebut.
4. Firestore Console > buat collection `admins`.
5. Document ID = UID Firebase admin.
6. Isi field:
   - `name` (string), mis. `Administrator`
   - `email` (string)
   - `role` (string) = `admin`
   - `active` (boolean) = `true`

Admin pertama dibuat dari Firebase Console karena belum ada admin yang bisa menulis collection `admins` dari web.

## 4. Ganti Apps Script lama

Paling mudah: tetap gunakan Apps Script yang sekarang terikat ke Spreadsheet lama, karena Spreadsheet itu nantinya menjadi tujuan export.

1. Buka Apps Script lama.
2. Backup kode lama.
3. Ganti kode utama dengan `Code.gs`.
4. Tampilkan file manifest (`Project Settings > Show appsscript.json manifest file`) lalu samakan dengan `appsscript.json`.
5. Jalankan `setupProject()` sekali dan setujui permission.

### Script Properties wajib

Apps Script > Project Settings > Script Properties:

```text
FIREBASE_PROJECT_ID        = project-id-firebase
FIREBASE_WEB_API_KEY       = API key dari Firebase Web config
GROQ_API_KEY               = key Groq yang sudah dipakai sebelumnya
SPREADSHEET_ID             = ID spreadsheet tujuan export
ALLOWED_FRONTEND_ORIGINS   = https://USERNAME.github.io
```

`setupProject()` otomatis mengisi `SPREADSHEET_ID` jika Apps Script dibuka dari spreadsheet yang menjadi tujuan export.

Jika memakai custom domain, tambahkan dipisahkan koma:

```text
https://USERNAME.github.io,https://daftar.domainanda.com
```

**Origin tidak memakai path repository.** Untuk URL `https://user.github.io/repo/`, origin-nya tetap `https://user.github.io`.

### Permission Firestore untuk Apps Script

`Code.gs` memakai OAuth Google milik account yang menjalankan Apps Script untuk memanggil Firestore REST API. Account tersebut harus memiliki akses IAM ke Firebase/Google Cloud project (umumnya aman jika Firebase dan Apps Script dimiliki account Google yang sama).

Jika muncul `Firestore API 403`, pastikan:

- Firestore sudah dibuat di Firebase project.
- Apps Script dijalankan oleh account yang punya akses ke Firebase project.
- Firestore API aktif di Google Cloud project tersebut.
- Manifest sudah memiliki scope `https://www.googleapis.com/auth/datastore`, lalu authorize ulang script.

## 5. Deploy Apps Script

Deploy > Manage deployments > Web app:

- **Execute as:** Me
- **Who has access:** Anyone

Deploy/update deployment.

`config.js` pada paket ini masih menggunakan URL Apps Script yang Anda kirim sebelumnya. Jika deployment baru menghasilkan URL berbeda, ganti `backendUrl`.

## 6. Firebase Authorized Domains

Firebase Console > Authentication > Settings > Authorized domains.

Tambahkan:

```text
USERNAME.github.io
```

Jika menggunakan domain sendiri, tambahkan domain itu juga.

## 7. Upload ke GitHub Pages

Upload file/folder ini ke repository GitHub, contoh:

```text
membership/
  index.html
  admin.html
  styles.css
  admin.css
  app.js
  config.js
  js/
    admin.js
    firebase-config.js
```

`Code.gs`, `appsscript.json`, dan `firestore.rules` boleh disimpan di repository sebagai source/config reference karena tidak berisi key rahasia. Jangan commit nilai secret Script Properties.

GitHub > Repository > Settings > Pages:

- Source: **Deploy from a branch**
- Branch: `main`
- Folder: `/ (root)`

Contoh URL:

```text
https://USERNAME.github.io/membership/
https://USERNAME.github.io/membership/admin.html
```

## 8. Alur pemakaian

1. Login ke `admin.html`.
2. Menu **Kelas** > buat kelas, contoh `5AAE89A5`.
3. Menu **Voucher** > pilih kelas tersebut > tambah voucher atau generate batch.
4. Kembali ke **Kelas** > klik `Salin Link`.
5. Link yang dibagikan otomatis berbentuk:

```text
https://USERNAME.github.io/membership/?kelas=5AAE89A5
```

6. Pendaftar mengisi NIK + data lain.
7. Apps Script memvalidasi data dan preview Groq.
8. Saat submit:
   - kelas harus aktif;
   - NIK belum boleh terdaftar;
   - voucher `available` harus tersedia pada kelas tersebut;
   - transaksi membuat `members/{NIK}` dan mengubah voucher menjadi `assigned`.
9. Admin melihat anggota pada panel.
10. Menu **Export** menghasilkan/menyegarkan sheet `Export <KODE KELAS>` atau `Export Semua`.

## Catatan keamanan penting

- Jangan pakai rule `allow read, write: if true`.
- Jangan taruh `GROQ_API_KEY` di HTML/JS/GitHub.
- Jangan taruh service-account private key di repository.
- NIK disimpan sebagai string/document ID, bukan Number.
- NIK yang ditampilkan di tabel admin dimasking sebagian; data lengkap tetap tersimpan di Firestore.
- Kelas dan voucher tidak dapat diklaim langsung dari browser publik; submit publik lewat Apps Script.

## Jika ingin mengganti URL Apps Script

Edit `config.js`:

```js
window.APP_CONFIG = Object.freeze({
  backendUrl: "https://script.google.com/macros/s/DEPLOYMENT_ID/exec",
  requestTimeoutMs: 45000
});
```

## 9. Migrasi data Spreadsheet lama

Karena data lama yang Anda kirim belum mempunyai NIK, **jangan jalankan migrasi sebelum setiap baris memiliki NIK 16 digit yang benar**.

1. Tambahkan header `NIK` di baris header sheet lama (baris 3). Posisi kolom bebas; helper membaca berdasarkan nama header.
2. Isi NIK untuk semua anggota lama.
3. Buat kelas tujuan terlebih dahulu dari Admin Panel dengan kode yang sama seperti sheet lama.
4. Tambahkan file `LegacyMigration.gs` ke project Apps Script yang sama.
5. Jika sheet bukan `Data Anggota`, set Script Property `LEGACY_SHEET_NAME`.
6. Jika kode kelas tidak berada di `B1`, set Script Property `LEGACY_CLASS_CODE`.
7. Jalankan manual:

```text
migrateLegacySheetToFirestore()
```

Helper akan:

- memakai NIK sebagai `members/{NIK}`;
- melewati NIK yang sudah ada;
- membawa data pribadi/rekening/baju;
- membawa voucher lama sebagai voucher `assigned` pada kelas tersebut;
- mempertahankan nomor pendaftaran bila kolom `NO.` tersedia;
- tidak menghapus atau mengubah data sheet lama.

Periksa Execution Log setelah migrasi. Baris yang gagal akan dilaporkan dengan nomor baris dan alasannya.
