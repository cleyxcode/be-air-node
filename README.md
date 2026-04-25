# Siram Pintar API (Node.js Version)

Ini adalah porting dari versi Python API (`ml-api`) ke Node.js. Fitur dan alurnya telah dibuat sama persis (logika cuaca adaptif, debounce, webhook DB, dsb).

## Cara Menjalankan

1. **Instalasi Dependensi**
   Buka terminal di folder ini dan jalankan:
   ```bash
   npm install
   ```

2. **Konfigurasi Environment**
   - Copy file `.env.example` menjadi `.env`
   - Isi kredensial database (host, user, password, db) dan `API_KEY` Anda.

3. **Menjalankan Server**
   ```bash
   npm start
   # atau jika ingin auto-reload saat koding:
   npm run dev
   ```
   Server akan berjalan di `http://localhost:8000` (atau port di .env).

## Integrasi Model KNN

Karena model yang Anda latih kemungkinan berupa format `.pkl` (scikit-learn dari Python), file `.pkl` **tidak bisa** langsung diload native di Node.js. Berikut adalah beberapa cara untuk mengintegrasikan model Anda ke dalam kode Node.js ini:

### Opsi 1: Panggil Skrip Python dari Node.js (Paling Mudah)
Anda bisa membuat file python kecil (misal `predict.py`) yang melakukan load model `.pkl`. Lalu di `index.js`, pada fungsi `classify(soil, temp, rh)`, gunakan modul bawaan `child_process` (atau library `python-shell`) untuk menjalankan file python tersebut dan mengembalikan output JSON.

### Opsi 2: Konversi Model ke ONNX
1. Di Python, gunakan `skl2onnx` untuk mengkonversi model KNN menjadi `.onnx`.
2. Di Node.js, gunakan library `onnxruntime-node` untuk meload dan menjalankan inference model tersebut secara native di Node.js (sangat cepat).

### Opsi 3: Tulis Ulang Logika KNN di JS (Hanya jika K kecil)
Karena algoritma K-Nearest Neighbors adalah menghitung jarak *euclidean* ke sampel latih, Anda bisa menyimpan centroid atau sample data latih sebagai `.json`, lalu menulis fungsi jarak di `index.js` pada blok `classify`. Namun ini kurang ideal jika data latihnya sangat besar.

### Opsi 4: Gunakan API Microservice Python
Biarkan Node.js menangani semua request publik, database, auth, dan logika smart-watering (Express).
Namun khusus untuk prediksi KNN, Node.js menembak HTTP Request (Axios/Fetch) secara internal ke server FastAPI python yang ringan dan *hanya* menangani model `.pkl`.

---

**CATATAN**:
Silahkan cek function `classify(soil, temp, rh)` di `index.js` (sekitar baris 200). Fungsi ini masih berupa *stub / mock*. Ganti isinya dengan salah satu opsi di atas.
