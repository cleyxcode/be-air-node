const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const { z } = require('zod');

dotenv.config();

// ── Logging ───────────────────────────────────────────────────────────────────
const log = {
    info: (...args) => console.log(`[INFO]`, new Date().toISOString(), ...args),
    warning: (...args) => console.warn(`[WARNING]`, new Date().toISOString(), ...args),
    error: (...args) => console.error(`[ERROR]`, new Date().toISOString(), ...args),
    debug: (...args) => console.debug(`[DEBUG]`, new Date().toISOString(), ...args)
};

// ── MySQL config ──────────────────────────────────────────────────────────────
const DB_HOST = process.env.DB_HOST || "srv1987.hstgr.io";
const DB_PORT = parseInt(process.env.DB_PORT || "3306", 10);
const DB_USER = process.env.DB_USER || "";
const DB_PASS = process.env.DB_PASS || "";
const DB_NAME = process.env.DB_NAME || "";

const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ── API Key ───────────────────────────────────────────────────────────────────
const VALID_API_KEY = process.env.API_KEY || "";

const verifyApiKey = (req, res, next) => {
    const apiKey = req.header("X-API-Key");
    if (!VALID_API_KEY) {
        log.warning("API_KEY belum di-set di environment variable!");
        return next();
    }
    if (apiKey !== VALID_API_KEY) {
        log.warning(`Akses ditolak: API key tidak valid '${apiKey}'`);
        return res.status(401).json({
            error: "Unauthorized",
            message: "API key tidak valid atau tidak ada. Sertakan header: X-API-Key: <key>"
        });
    }
    next();
};

// ── Global Safety State ──────────────
const dailySafety = {
    date: null,
    watering_count: 0,
    locked_out: false,
    last_pump_duration_sec: 0
};

// ══════════════════════════════════════════════════════════════════════════════
// KONFIGURASI
// ══════════════════════════════════════════════════════════════════════════════
const CFG = {
    MORNING_WINDOW: [5, 7],
    EVENING_WINDOW: [16, 18],

    SOIL_DRY_ON: 45.0,
    SOIL_WET_OFF: 70.0,
    CRITICAL_DRY: 20.0,

    RAIN_SCORE_THRESHOLD: 60,
    RAIN_RH_HEAVY: 92.0,
    RAIN_RH_MODERATE: 85.0,
    RAIN_RH_LIGHT: 78.0,
    RAIN_SOIL_RISE_HEAVY: 8.0,
    RAIN_SOIL_RISE_LIGHT: 3.0,
    RAIN_TEMP_DROP: 3.0,
    RAIN_CLEAR_THRESHOLD: 30,
    RAIN_CONFIRM_READINGS: 2,
    RAIN_CLEAR_READINGS: 3,

    COOLDOWN_MINUTES: 45,
    POST_RAIN_COOLDOWN_MINUTES: 120,
    MIN_SESSION_GAP_MINUTES: 10,

    MAX_PUMP_DURATION_MINUTES: 5,
    MIN_PUMP_DURATION_SECONDS: 30,

    HOT_TEMP_THRESHOLD: 34.0,

    CONFIDENCE_NORMAL: 60.0,
    CONFIDENCE_HOT: 40.0,
    CONFIDENCE_MISSED: 48.0,

    CONTROL_DEBOUNCE_SECONDS: 5,
    SENSOR_DEBOUNCE_SECONDS: 10,
    SENSOR_TOLERANCE: 1.0
};

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

let modelMeta = { best_k: "?", accuracy: "?" }; // Set metadata model Anda di sini

// ══════════════════════════════════════════════════════════════════════════════
// SCHEMA (Zod)
// ══════════════════════════════════════════════════════════════════════════════
const sensorSchema = z.object({
    soil_moisture: z.number().min(0).max(100),
    temperature: z.number().min(0).max(60),
    air_humidity: z.number().min(0).max(100),
    hour: z.number().min(0).max(23).optional().nullable(),
    minute: z.number().min(0).max(59).optional().nullable(),
    day: z.number().min(0).max(6).optional().nullable()
});

const controlSchema = z.object({
    action: z.string().refine(val => ["on", "off"].includes(val.toLowerCase()), { message: "Action harus 'on' atau 'off'" }),
    mode: z.string().optional().default("manual")
});

const validateBody = (schema) => (req, res, next) => {
    try {
        req.body = schema.parse(req.body);
        next();
    } catch (err) {
        return res.status(422).json({ error: "Validation Error", details: err.errors });
    }
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPER: Waktu WIT
// ══════════════════════════════════════════════════════════════════════════════
function resolveTimeWit(hour, minute, day) {
    if (hour != null && minute != null && day != null) {
        return { h: hour, m: minute, d: day, source: "esp32" };
    }
    const now = new Date();
    // UTC ke WIT (UTC+9)
    const h = (now.getUTCHours() + 9) % 24;
    const wday = now.getUTCDay(); // 0 is Sunday
    log.warning(`Fallback waktu server WIT: ${h.toString().padStart(2, '0')}:${now.getUTCMinutes()}`);
    return { h, m: now.getUTCMinutes(), d: wday, source: "server_fallback" };
}

function totalMinutes(hour, minute) {
    return hour * 60 + minute;
}

function elapsedMinutes(current, stored) {
    if (stored == null) return 999999;
    let diff = current - parseInt(stored, 10);
    return diff >= 0 ? diff : diff + 1440;
}

function elapsedSecondsReal(storedTsStr) {
    if (!storedTsStr) return 999999.0;
    try {
        const stored = new Date(storedTsStr);
        return (new Date() - stored) / 1000.0;
    } catch (e) {
        return 999999.0;
    }
}

function inWateringWindow(hour) {
    if (hour >= CFG.MORNING_WINDOW[0] && hour <= CFG.MORNING_WINDOW[1]) return [true, "pagi"];
    if (hour >= CFG.EVENING_WINDOW[0] && hour <= CFG.EVENING_WINDOW[1]) return [true, "sore"];
    return [false, ""];
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER: system_state
// ══════════════════════════════════════════════════════════════════════════════
const STATE_DEFAULTS = {
    pump_status: false,
    mode: "auto",
    last_label: null,
    last_updated: null,
    pump_start_ts: null,
    pump_start_minute: null,
    last_watered_minute: null,
    last_watered_ts: null,
    last_soil_moisture: null,
    last_temperature: null,
    missed_session: false,
    rain_detected: false,
    rain_score: 0,
    rain_confirm_count: 0,
    rain_clear_count: 0,
    rain_started_minute: null,
    last_control_ts: null,
    last_sensor_ts: null,
    last_sensor_soil: null,
    session_count_today: 0,
    session_count_date: null
};

async function getState() {
    try {
        const [rows] = await pool.query("SELECT * FROM system_state WHERE id = 1");
        if (!rows || rows.length === 0) return { ...STATE_DEFAULTS };
        
        let row = rows[0];
        const boolKeys = ["pump_status", "missed_session", "rain_detected"];
        boolKeys.forEach(k => row[k] = !!row[k]);

        const intKeys = ["rain_score", "rain_confirm_count", "rain_clear_count", "session_count_today"];
        intKeys.forEach(k => row[k] = parseInt(row[k] || 0, 10));

        for (const [k, v] of Object.entries(STATE_DEFAULTS)) {
            if (row[k] === undefined || row[k] === null) row[k] = v;
        }
        return row;
    } catch (err) {
        log.error("getState error:", err.message);
        return { ...STATE_DEFAULTS };
    }
}

async function updateState(kwargs) {
    if (!kwargs || Object.keys(kwargs).length === 0) return;
    const keys = Object.keys(kwargs);
    const sets = keys.map(k => `${k} = ?`).join(", ");
    const values = Object.values(kwargs);
    
    try {
        await pool.query(`UPDATE system_state SET ${sets} WHERE id = 1`, values);
    } catch (err) {
        log.error("updateState error:", err.message);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// KNN Classify (STUB / PLACEHOLDER UNTUK MODEL ANDA)
// ══════════════════════════════════════════════════════════════════════════════
function classify(soil, temp, rh) {
    // TODO: GANTI FUNGSI INI DENGAN LOGIKA INFERENSI MODEL KNN ANDA!
    // Karena scikit-learn (.pkl) tidak bisa langsung diload di Node.js,
    // Anda bisa memanggil python-shell, atau me-rewrite jarak euclidean KNN,
    // atau menggunakan ONNX Runtime Node.
    
    // CONTOH DUMMY RESPONSE:
    let label = soil < 40 ? "Kering" : "Basah";
    let conf = 85.0;
    
    return {
        label: label,
        confidence: conf,
        probabilities: { "Kering": 85.0, "Basah": 15.0 },
        needs_watering: label === "Kering",
        description: `Dummy deskripsi untuk label ${label}`
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// DETEKSI HUJAN
// ══════════════════════════════════════════════════════════════════════════════
function computeRainScore(air_humidity, soil_moisture, temperature, last_soil, last_temp, pump_was_on) {
    let score = 0;
    let signals = [];

    if (air_humidity >= CFG.RAIN_RH_HEAVY) {
        score += 50; signals.push(`RH=${air_humidity.toFixed(0)}% (lebat)`);
    } else if (air_humidity >= CFG.RAIN_RH_MODERATE) {
        score += 30; signals.push(`RH=${air_humidity.toFixed(0)}% (sedang)`);
    } else if (air_humidity >= CFG.RAIN_RH_LIGHT) {
        score += 15; signals.push(`RH=${air_humidity.toFixed(0)}% (ringan)`);
    }

    if (!pump_was_on && last_soil != null) {
        let delta = soil_moisture - parseFloat(last_soil);
        if (delta >= CFG.RAIN_SOIL_RISE_HEAVY) {
            score += 35; signals.push(`tanah +${delta.toFixed(1)}% (cepat)`);
        } else if (delta >= CFG.RAIN_SOIL_RISE_LIGHT) {
            score += 20; signals.push(`tanah +${delta.toFixed(1)}% (perlahan)`);
        }
    }

    if (last_temp != null) {
        let temp_drop = parseFloat(last_temp) - temperature;
        if (temp_drop >= CFG.RAIN_TEMP_DROP) {
            score += 15; signals.push(`suhu turun -${temp_drop.toFixed(1)}°C`);
        }
    }

    return [Math.min(score, 100), signals];
}

async function updateRainState(score, signals, state, current_min) {
    let currently_raining = state.rain_detected;
    let confirm_count = state.rain_confirm_count;
    let clear_count = state.rain_clear_count;

    if (score >= CFG.RAIN_SCORE_THRESHOLD) {
        confirm_count += 1;
        clear_count = 0;

        if (!currently_raining && confirm_count >= CFG.RAIN_CONFIRM_READINGS) {
            log.info(`HUJAN DIKONFIRMASI: skor=${score}, sinyal=[${signals.join(', ')}]`);
            await updateState({
                rain_detected: true, rain_score: score,
                rain_confirm_count: confirm_count, rain_clear_count: 0,
                rain_started_minute: current_min, missed_session: true,
            });
            return [true, `Hujan dikonfirmasi (skor=${score}, ${signals.join(', ')})`];
        } else if (currently_raining) {
            await updateState({ rain_score: score, rain_confirm_count: confirm_count, rain_clear_count: 0 });
            return [true, `Hujan berlanjut (skor=${score})`];
        } else {
            await updateState({ rain_score: score, rain_confirm_count: confirm_count, rain_clear_count: 0 });
            return [false, `Menunggu konfirmasi hujan (${confirm_count}/${CFG.RAIN_CONFIRM_READINGS}, skor=${score})`];
        }
    } else if (score <= CFG.RAIN_CLEAR_THRESHOLD) {
        clear_count += 1;
        confirm_count = 0;

        if (currently_raining && clear_count >= CFG.RAIN_CLEAR_READINGS) {
            log.info(`HUJAN SELESAI: skor=${score}`);
            await updateState({
                rain_detected: false, rain_score: score,
                rain_confirm_count: 0, rain_clear_count: clear_count,
            });
            return [false, ""];
        } else if (currently_raining) {
            await updateState({ rain_score: score, rain_confirm_count: 0, rain_clear_count: clear_count });
            return [true, `Hujan mungkin selesai, tunggu konfirmasi (${clear_count}/${CFG.RAIN_CLEAR_READINGS})`];
        } else {
            await updateState({ rain_score: score, rain_confirm_count: 0, rain_clear_count: clear_count });
            return [false, ""];
        }
    } else {
        if (currently_raining) {
            await updateState({ rain_score: score });
            return [true, `Hujan ambiguos (skor=${score}), tetap aktif`];
        }
        return [false, ""];
    }
}

function shouldSkipSensor(data, state) {
    if (data.soil_moisture <= 0.0 || data.temperature <= 0.0 || data.temperature >= 60.0) {
        log.warning(`ANOMALI SENSOR: Nilai tidak masuk akal (Soil=${data.soil_moisture}%, Temp=${data.temperature}°C). Data diabaikan.`);
        return true;
    }

    let last_soil = state.last_sensor_soil;
    if (last_soil != null) {
        if (Math.abs(data.soil_moisture - parseFloat(last_soil)) > 30.0) {
            log.warning(`ANOMALI SENSOR: Perubahan drastis >30% (${parseFloat(last_soil)}% -> ${data.soil_moisture}%). Data diabaikan.`);
            return true;
        }
    }

    let elapsed = elapsedSecondsReal(state.last_sensor_ts);
    if (elapsed > CFG.SENSOR_DEBOUNCE_SECONDS) return false;
    if (last_soil == null) return false;
    return Math.abs(data.soil_moisture - parseFloat(last_soil)) <= CFG.SENSOR_TOLERANCE;
}

// ══════════════════════════════════════════════════════════════════════════════
// MESIN KEPUTUSAN AUTO
// ══════════════════════════════════════════════════════════════════════════════
async function evaluateSmartWatering(result, hour, minute, soil_moisture, air_humidity, temperature, state, current_total_minutes) {
    const currentDateStr = new Date().toISOString().split('T')[0];
    if (dailySafety.date !== currentDateStr) {
        dailySafety.date = currentDateStr;
        dailySafety.watering_count = 0;
        dailySafety.locked_out = false;
    }

    let resp = {
        action: null, reason: "", blocked_reason: null,
        is_raining: false, rain_score: 0,
        hot_mode: temperature >= CFG.HOT_TEMP_THRESHOLD,
        missed_session: !!state.missed_session,
        decision_path: [],
    };

    if (dailySafety.locked_out) {
        resp.blocked_reason = "Safety Lockout: Melebihi batas harian penyiraman maksimum (10x).";
        resp.decision_path.push("SAFETY_LOCKOUT");
        return resp;
    }

    const block = (code, reason) => { resp.blocked_reason = reason; resp.decision_path.push(code); };
    const actOn = (code, reason) => { resp.action = "on"; resp.reason = reason; resp.decision_path.push(code); };
    const actOff = (code, reason) => { resp.action = "off"; resp.reason = reason; resp.decision_path.push(code); };

    let [rain_score, rain_signals] = computeRainScore(
        air_humidity, soil_moisture, temperature,
        state.last_soil_moisture, state.last_temperature, !!state.pump_status
    );
    let [is_raining, rain_reason] = await updateRainState(rain_score, rain_signals, state, current_total_minutes);
    
    resp.is_raining = is_raining;
    resp.rain_score = rain_score;

    let dynamic_dry_on = CFG.SOIL_DRY_ON;
    let dynamic_wet_off = CFG.SOIL_WET_OFF;

    if (resp.hot_mode) {
        dynamic_dry_on += 5.0;
        dynamic_wet_off += 5.0;
        resp.decision_path.push("T-HOT_ADJUST");
    } else if (temperature < 25.0 && air_humidity > 80.0) {
        dynamic_dry_on -= 5.0;
        dynamic_wet_off -= 5.0;
        resp.decision_path.push("T-COOL_ADJUST");
    }

    if (state.missed_session) {
        dynamic_wet_off += 5.0;
        resp.decision_path.push("T-MISSED_ADJUST");
    }

    dynamic_wet_off = Math.min(95.0, dynamic_wet_off);
    dynamic_dry_on = Math.max(CFG.CRITICAL_DRY + 5.0, dynamic_dry_on);

    let [in_window, window_label] = inWateringWindow(hour);
    let night_emergency = (!in_window && soil_moisture <= CFG.CRITICAL_DRY && !is_raining);
    if (night_emergency) window_label = "malam-darurat";

    if (state.pump_status) {
        let elapsed_sec = elapsedSecondsReal(state.pump_start_ts);
        let max_sec = night_emergency ? 60 : (CFG.MAX_PUMP_DURATION_MINUTES * 60);

        if (elapsed_sec >= max_sec) {
            dailySafety.last_pump_duration_sec = elapsed_sec;
            await updateState({
                pump_status: false, last_watered_minute: current_total_minutes,
                last_watered_ts: new Date().toISOString(), pump_start_ts: null,
                pump_start_minute: null, missed_session: false
            });
            actOff("A1", `Auto-stop: batas maksimal (${elapsed_sec.toFixed(0)}s).`);
            return resp;
        }

        if (elapsed_sec < CFG.MIN_PUMP_DURATION_SECONDS) {
            resp.reason = `Pompa ON, warmup (${elapsed_sec.toFixed(0)}s < ${CFG.MIN_PUMP_DURATION_SECONDS}s).`;
            resp.decision_path.push("A-warmup");
            return resp;
        }

        if (soil_moisture >= dynamic_wet_off) {
            dailySafety.last_pump_duration_sec = elapsed_sec;
            await updateState({
                pump_status: false, last_watered_minute: current_total_minutes,
                last_watered_ts: new Date().toISOString(), pump_start_ts: null,
                pump_start_minute: null, missed_session: false
            });
            actOff("A2", `Auto-stop: tanah cukup (${soil_moisture.toFixed(1)}% >= ${dynamic_wet_off.toFixed(1)}%).`);
            return resp;
        }

        if (is_raining) {
            dailySafety.last_pump_duration_sec = elapsed_sec;
            await updateState({
                pump_status: false, last_watered_minute: current_total_minutes,
                last_watered_ts: new Date().toISOString(), pump_start_ts: null,
                pump_start_minute: null, missed_session: false
            });
            actOff("A3", `Auto-stop: ${rain_reason}. Hujan menggantikan siram.`);
            return resp;
        }

        resp.reason = `Pompa ON (${elapsed_sec.toFixed(0)}s/${max_sec.toFixed(0)}s). Tanah=${soil_moisture.toFixed(1)}%.`;
        resp.decision_path.push("A4-running");
        return resp;
    }

    let has_missed = !!state.missed_session;

    if (night_emergency || (soil_moisture <= CFG.CRITICAL_DRY && !is_raining)) {
        let now_ts = new Date().toISOString();
        dailySafety.watering_count++;
        if (dailySafety.watering_count >= 10) dailySafety.locked_out = true;

        await updateState({ pump_status: true, pump_start_minute: current_total_minutes, pump_start_ts: now_ts });
        actOn("B1", `SIRAM DARURAT [${window_label}]: tanah ${soil_moisture.toFixed(1)}% <= ${CFG.CRITICAL_DRY}%.`);
        return resp;
    }

    if (!in_window) {
        block("B2", `Di luar jam aman. WIT=${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}.`);
        return resp;
    }

    if (is_raining) {
        block("B3", `${rain_reason}. Ditunda.`);
        return resp;
    }

    if (soil_moisture >= dynamic_wet_off) {
        if (has_missed) await updateState({ missed_session: false });
        block("B4", `Tanah sudah basah (${soil_moisture.toFixed(1)}%).`);
        return resp;
    }

    let effective_cooldown = has_missed ? CFG.POST_RAIN_COOLDOWN_MINUTES : CFG.COOLDOWN_MINUTES;
    if (dailySafety.last_pump_duration_sec < 120 && !has_missed) {
        effective_cooldown = 15;
        resp.decision_path.push("ADAPTIVE_COOLDOWN");
    }
    let elapsed_cd = elapsedMinutes(current_total_minutes, state.last_watered_minute);
    if (elapsed_cd < effective_cooldown) {
        block("B5", `Cooldown: sisa ${effective_cooldown - elapsed_cd} mnt.`);
        return resp;
    }

    let elapsed_gap = elapsedMinutes(current_total_minutes, state.last_watered_minute);
    if (elapsed_gap < CFG.MIN_SESSION_GAP_MINUTES) {
        block("B6", `Gap minimum belum tercapai (${elapsed_gap} mnt).`);
        return resp;
    }

    if (!result.needs_watering) {
        block("B7", `KNN label='${result.label}' (${result.confidence}%).`);
        return resp;
    }

    let threshold, ctx;
    if (resp.hot_mode) {
        threshold = CFG.CONFIDENCE_HOT; ctx = "suhu panas";
    } else if (has_missed) {
        threshold = CFG.CONFIDENCE_MISSED; ctx = "hutang siram";
    } else {
        threshold = CFG.CONFIDENCE_NORMAL; ctx = "normal";
    }

    if (result.confidence < threshold) {
        block("B8", `Confidence ${result.confidence}% < ${threshold}% (${ctx}).`);
        return resp;
    }

    if (soil_moisture > dynamic_dry_on) {
        block("B9", `Tanah ${soil_moisture.toFixed(1)}% > batas on (${dynamic_dry_on.toFixed(1)}%).`);
        return resp;
    }

    let now_ts = new Date().toISOString();
    dailySafety.watering_count++;
    if (dailySafety.watering_count >= 10) dailySafety.locked_out = true;

    await updateState({ pump_status: true, pump_start_minute: current_total_minutes, pump_start_ts: now_ts });
    actOn("B10", `Siram [${window_label}]: KNN=${result.label} (${result.confidence}%), suhu=${temperature.toFixed(1)}°C, tanah=${soil_moisture.toFixed(1)}%.`);
    return resp;
}

// ══════════════════════════════════════════════════════════════════════════════
// ENDPOINT: Public
// ══════════════════════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
    res.json({
        status: "online",
        message: "Siram Pintar API berjalan (Node.js ver)",
        version: "6.0.0",
        model_ready: true, // Ubah ke logika check model asli
        auth: VALID_API_KEY ? "required" : "disabled"
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// ENDPOINT: Protected
// ══════════════════════════════════════════════════════════════════════════════

app.get("/db-test", verifyApiKey, async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT 1 AS ok");
        res.json({ db_status: "connected", result: rows[0] });
    } catch (e) {
        res.json({ db_status: "error", detail: e.message });
    }
});

app.get("/model-info", verifyApiKey, (req, res) => {
    res.json(modelMeta);
});

// Global Locks (dalam node.js eksekusi sinkronus event loop mencegah race cond sederhana, 
// tapi kita bisa menggunakan antrian / flag sederhana jika diperlukan, untuk async)
let sensorLock = false;
let controlLock = false;

app.post("/sensor", verifyApiKey, validateBody(sensorSchema), async (req, res) => {
    if (sensorLock) return res.status(429).json({ error: "Terlalu banyak permintaan (Lock aktif)" });
    sensorLock = true;

    try {
        const data = req.body;
        const result = classify(data.soil_moisture, data.temperature, data.air_humidity);
        const state = await getState();
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' '); // YYYY-MM-DD HH:MM:SS
        const row_id = uuidv4();

        const { h: hour, m: minute, source: time_source } = resolveTimeWit(data.hour, data.minute, data.day);
        const current_total_minutes = totalMinutes(hour, minute);

        if (Math.random() < 0.05) {
            try {
                await pool.query("DELETE FROM sensor_readings WHERE timestamp < NOW() - INTERVAL 14 DAY");
            } catch (e) {
                log.error("Gagal auto-prune database:", e.message);
            }
        }

        const skip_eval = shouldSkipSensor(data, state);

        if (skip_eval) {
            let elapsed_spam = elapsedSecondsReal(state.last_sensor_ts);
            if (elapsed_spam < 2.0) {
                log.debug(`Spam filter: Request terlalu cepat (${elapsed_spam.toFixed(1)}s), abaikan operasi DB.`);
                return res.json({
                    received: true,
                    timestamp: state.last_updated || timestamp,
                    device_time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
                    time_source: time_source,
                    debounced: true,
                    sensor: { soil_moisture: data.soil_moisture, temperature: data.temperature, air_humidity: data.air_humidity },
                    classification: result,
                    pump_status: state.pump_status,
                    pump_action: null,
                    mode: state.mode,
                    auto_info: null
                });
            }
        }

        let final_action = null;
        let smart_eval = {};

        if (state.mode === "manual") {
            // Do nothing
        } else if (state.mode === "auto" && !skip_eval) {
            smart_eval = await evaluateSmartWatering(
                result, hour, minute, data.soil_moisture, data.air_humidity,
                data.temperature, state, current_total_minutes
            );
            final_action = smart_eval.action;
        } else if (state.mode === "auto" && skip_eval) {
            log.debug("Sensor debounce: skip evaluasi.");
        }

        await updateState({
            last_label: result.label, last_updated: timestamp,
            last_soil_moisture: data.soil_moisture, last_temperature: data.temperature,
            last_sensor_ts: new Date().toISOString(), last_sensor_soil: data.soil_moisture
        });

        const new_state = await getState();
        const pump_status_logged = final_action === "on" ? true : (final_action === "off" ? false : new_state.pump_status);

        await pool.query(
            `INSERT INTO sensor_readings
             (id, timestamp, soil_moisture, temperature, air_humidity,
              label, confidence, needs_watering, description, probabilities, pump_status, mode)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row_id, timestamp, data.soil_moisture, data.temperature, data.air_humidity,
             result.label, result.confidence, result.needs_watering,
             result.description || "", JSON.stringify(result.probabilities),
             pump_status_logged, state.mode]
        );

        res.json({
            received: true, timestamp,
            device_time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
            time_source: time_source, debounced: skip_eval,
            sensor: { soil_moisture: data.soil_moisture, temperature: data.temperature, air_humidity: data.air_humidity },
            classification: result, pump_status: new_state.pump_status,
            pump_action: final_action, mode: new_state.mode,
            auto_info: state.mode === "auto" ? {
                is_raining: smart_eval.is_raining || false,
                rain_score: smart_eval.rain_score || 0,
                hot_mode: smart_eval.hot_mode || false,
                missed_session: smart_eval.missed_session || false,
                reason: smart_eval.reason || "",
                blocked_reason: smart_eval.blocked_reason || null,
                decision_path: smart_eval.decision_path || [],
            } : null
        });

    } finally {
        sensorLock = false;
    }
});

app.get("/status", verifyApiKey, async (req, res) => {
    const state = await getState();
    let latest = null;
    try {
        const [rows] = await pool.query("SELECT * FROM sensor_readings ORDER BY timestamp DESC LIMIT 1");
        if (rows.length > 0) {
            latest = rows[0];
            if (typeof latest.probabilities === "string") {
                try { latest.probabilities = JSON.parse(latest.probabilities); } catch (e) {}
            }
            latest.pump_status = !!latest.pump_status;
            latest.needs_watering = !!latest.needs_watering;
        }
    } catch (e) {}

    res.json({
        pump_status: state.pump_status,
        mode: state.mode,
        last_label: state.last_label,
        last_updated: state.last_updated ? String(state.last_updated) : null,
        is_raining: state.rain_detected || false,
        rain_score: state.rain_score || 0,
        missed_session: state.missed_session || false,
        watering_windows: {
            morning: `${CFG.MORNING_WINDOW[0].toString().padStart(2, '0')}:00–${CFG.MORNING_WINDOW[1].toString().padStart(2, '0')}:59 WIT`,
            evening: `${CFG.EVENING_WINDOW[0].toString().padStart(2, '0')}:00–${CFG.EVENING_WINDOW[1].toString().padStart(2, '0')}:59 WIT`
        },
        thresholds: {
            soil_dry_on: CFG.SOIL_DRY_ON,
            soil_wet_off: CFG.SOIL_WET_OFF,
            critical_dry: CFG.CRITICAL_DRY
        },
        latest_data: latest
    });
});

app.get("/history", verifyApiKey, async (req, res) => {
    let limit = parseInt(req.query.limit || "50", 10);
    if (limit < 1) limit = 1;
    if (limit > 500) limit = 500;

    try {
        const [rows] = await pool.query("SELECT * FROM sensor_readings ORDER BY timestamp DESC LIMIT ?", [limit]);
        const records = rows.map(r => {
            if (typeof r.probabilities === "string") {
                try { r.probabilities = JSON.parse(r.probabilities); } catch(e) {}
            }
            r.pump_status = !!r.pump_status;
            r.needs_watering = !!r.needs_watering;
            return r;
        }).reverse();
        
        res.json({ total: records.length, records });
    } catch (err) {
        res.status(500).json({ error: "Database error", details: err.message });
    }
});

app.post("/control", verifyApiKey, validateBody(controlSchema), async (req, res) => {
    if (controlLock) return res.status(429).json({ error: "Control processing" });
    controlLock = true;
    try {
        const action = (req.body.action || "").toLowerCase().trim();
        const mode = ["auto", "manual"].includes((req.body.mode || "").toLowerCase().trim()) ? req.body.mode.toLowerCase().trim() : "manual";
        
        const state = await getState();
        const pump_on = action === "on";

        const same_state = state.pump_status === pump_on;
        const same_mode = state.mode === mode;

        if (same_state && same_mode) {
            return res.json({
                success: true, debounced: true,
                message: "Status pompa dan mode tidak berubah, perintah duplikat diabaikan.",
                pump_status: state.pump_status, mode: state.mode,
                timestamp: state.last_control_ts || new Date().toISOString()
            });
        }

        let now_ts = new Date().toISOString();
        let update_kwargs = { mode, last_control_ts: now_ts };

        if (!same_state) {
            update_kwargs.pump_status = pump_on;
            if (!pump_on) {
                update_kwargs.pump_start_ts = null;
                update_kwargs.pump_start_minute = null;
                update_kwargs.last_watered_ts = now_ts;
                const { h, m } = resolveTimeWit(null, null, null);
                update_kwargs.last_watered_minute = totalMinutes(h, m);
            } else {
                update_kwargs.pump_start_ts = now_ts;
                const now_utc = new Date();
                const h_wit = (now_utc.getUTCHours() + 9) % 24;
                update_kwargs.pump_start_minute = totalMinutes(h_wit, now_utc.getUTCMinutes());
            }
        }

        await updateState(update_kwargs);
        const new_state = await getState();

        res.json({
            success: true, debounced: false,
            pump_status: new_state.pump_status,
            mode: new_state.mode, timestamp: now_ts
        });
    } finally {
        controlLock = false;
    }
});

app.post("/predict", verifyApiKey, validateBody(sensorSchema), (req, res) => {
    const data = req.body;
    res.json({
        input: { soil_moisture: data.soil_moisture, temperature: data.temperature, air_humidity: data.air_humidity },
        result: classify(data.soil_moisture, data.temperature, data.air_humidity)
    });
});

app.get("/config", verifyApiKey, (req, res) => {
    res.json({
        watering_windows: {
            morning: `${CFG.MORNING_WINDOW[0].toString().padStart(2, '0')}:00–${CFG.MORNING_WINDOW[1].toString().padStart(2, '0')}:59`,
            evening: `${CFG.EVENING_WINDOW[0].toString().padStart(2, '0')}:00–${CFG.EVENING_WINDOW[1].toString().padStart(2, '0')}:59`
        },
        soil_thresholds: {
            dry_on_threshold: CFG.SOIL_DRY_ON,
            wet_off_threshold: CFG.SOIL_WET_OFF,
            critical_emergency: CFG.CRITICAL_DRY
        },
        rain_detection: {
            score_to_confirm: CFG.RAIN_SCORE_THRESHOLD,
            score_to_clear: CFG.RAIN_CLEAR_THRESHOLD,
            rh_heavy: CFG.RAIN_RH_HEAVY,
            rh_moderate: CFG.RAIN_RH_MODERATE,
            rh_light: CFG.RAIN_RH_LIGHT
        },
        pump_control: {
            max_duration_min: CFG.MAX_PUMP_DURATION_MINUTES,
            min_duration_sec: CFG.MIN_PUMP_DURATION_SECONDS,
            cooldown_normal: CFG.COOLDOWN_MINUTES,
            cooldown_post_rain: CFG.POST_RAIN_COOLDOWN_MINUTES
        },
        knn_confidence: {
            normal: CFG.CONFIDENCE_NORMAL,
            hot_weather: CFG.CONFIDENCE_HOT,
            missed_session: CFG.CONFIDENCE_MISSED,
            hot_threshold: CFG.HOT_TEMP_THRESHOLD
        }
    });
});

app.post("/reset-rain", verifyApiKey, async (req, res) => {
    await updateState({
        rain_detected: false, rain_score: 0, rain_confirm_count: 0,
        rain_clear_count: 0, rain_started_minute: null, missed_session: false
    });
    res.json({ success: true, message: "State hujan dan hutang siram di-reset." });
});

// START SERVER
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    log.info(`Server berjalan di port ${PORT}`);
});
