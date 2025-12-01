const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 3000;

// ====== CONFIG ======
const IPGEO_KEY = process.env.IPGEO_KEY || "3264359d276642dea6bdb95366fb8896";

// ====== MIDDLEWARE ======
app.use(cors());
app.use(bodyParser.json());

// ====== MYSQL CONNECTION ======
let db;
(async () => {
    db = await mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: 'Lani0143!!@@',
        database: 'fishing_log',
        waitForConnections: true,
        connectionLimit: 10
    });
    console.log("Connected to MySQL (Pool)");
})();

// ====== BAROMETRIC TREND ======
// Uses a 3-hour interval and 0.5 hPa threshold to smooth out noise
function calculateBaroTrend(current, prev) {
    if (current == null || prev == null) return null;

    const c = parseFloat(current);
    const p = parseFloat(prev);
    if (isNaN(c) || isNaN(p)) return null;

    const diff = c - p;

    if (diff > 0.5) return "Rising";
    if (diff < -0.5) return "Falling";
    return "Steady";
}

// ====== FETCH ASTRONOMY (IPGEO ONLY) ======
async function fetchAstronomyData(lat, lon, date) {
    try {
        if (!lat || !lon || !date) return null;

        const formattedDate = new Date(date).toISOString().split("T")[0];

        const url = `https://api.ipgeolocation.io/astronomy?apiKey=${IPGEO_KEY}&lat=${lat}&long=${lon}&date=${formattedDate}`;

        console.log("ASTRO FETCH URL:", url);

        const res = await axios.get(url);
        const data = res.data;

        return {
            sunrise: data.sunrise || null,
            sunset: data.sunset || null,
            moonrise: data.moonrise || null,
            moonset: data.moonset || null,
            moon_phase_name: data.moon_phase || null
        };
    } catch (err) {
        console.error("Astronomy API error:", err.message);
        return null;
    }
}

// ====== FETCH BAROMETRIC (OPEN-METEO) ======
async function fetchBarometricData(lat, lon, date) {
    try {
        if (!lat || !lon || !date) return null;

        const formattedDate = new Date(date).toISOString().split("T")[0];

        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&hourly=pressure_msl&start_date=${formattedDate}&end_date=${formattedDate}&timezone=America/Los_Angeles`;

        console.log("BARO FETCH URL:", url);

        const res = await axios.get(url);
        return res.data;
    } catch (err) {
        console.error("Barometric API error:", err.message);
        return null;
    }
}

// ====== FIND NEAREST HOURLY PRESSURE ======
function getNearestPressure(data, targetDate) {
    if (!data || !data.hourly || !data.hourly.time || !data.hourly.pressure_msl) return null;

    const times = data.hourly.time;
    const pressures = data.hourly.pressure_msl;

    let bestIdx = -1;
    let bestDiff = Infinity;

    for (let i = 0; i < times.length; i++) {
        const t = new Date(times[i]);
        const diff = Math.abs(t - targetDate);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
        }
    }

    if (bestIdx === -1) return null;
    return pressures[bestIdx];
}

// ====== INSERT NEW ENTRY ======
app.post('/log', async (req, res) => {
    try {
        const {
            title,
            date,
            time,
            latitude,
            longitude,
            area_name,
            species,
            technique,
            hatchery_wild,
            weather_temp,
            weather_condition,
            tide_stage,
            moon_phase,                 
            barometric_current,         
            barometric_prev3h,        
            tide_station_id_used,
            catch_status
        } = req.body;

        if (!title || !date || !time || (catch_status === undefined || catch_status === null)) {
            return res.status(400).json({ success: false, message: 'Missing required fields (title, date, time, catch_status)' });
        }

        // Astronomy lookup
        let astro = null;
        if (latitude && longitude) {
            astro = await fetchAstronomyData(latitude, longitude, date);
        }

        // Start with any manual baro input
        let baroCurrentVal = barometric_current ?? null;
        let baroPrevVal = barometric_prev3h ?? null;

        // Barometric lookup (3-hour)
        let baroData = null;
        if (latitude && longitude) {
            baroData = await fetchBarometricData(latitude, longitude, date);
        }

        if (baroData) {
            const catchDateTime = new Date(`${date}T${time}`);
            const prev3hDateTime = new Date(catchDateTime.getTime() - 3 * 60 * 60 * 1000);

            const apiCurrent = getNearestPressure(baroData, catchDateTime);
            const apiPrev3h = getNearestPressure(baroData, prev3hDateTime);

            if (apiCurrent != null) baroCurrentVal = apiCurrent;
            if (apiPrev3h != null) baroPrevVal = apiPrev3h;
        }

        const barometric_pressure_trend = calculateBaroTrend(baroCurrentVal, baroPrevVal);

        // Final moon phase name
        const moonPhaseName = astro?.moon_phase_name || moon_phase || null;

        const sql = `
            INSERT INTO fishing_entries 
            (title, date, time, latitude, longitude, area_name, species, technique, hatchery_wild,
            weather_temp, weather_condition, tide_stage,
            barometric_current, barometric_prev3h, barometric_pressure_trend,
            tide_station_id_used, catch_status,
            sunrise, sunset, moonrise, moonset, moon_phase_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const values = [
            title, date, time, latitude || null, longitude || null, area_name || null, 
            species || null, technique || null, hatchery_wild || null,
            weather_temp || null, weather_condition || null, tide_stage || null,
            baroCurrentVal, baroPrevVal, barometric_pressure_trend,
            tide_station_id_used || null, catch_status,
            astro?.sunrise || null,
            astro?.sunset || null,
            astro?.moonrise || null,
            astro?.moonset || null,
            moonPhaseName
        ];

        const [result] = await db.query(sql, values);

        return res.json({
            success: true,
            id: result.insertId,
            astro,
            baro: {
                barometric_current: baroCurrentVal,
                barometric_prev3h: baroPrevVal,
                barometric_pressure_trend
            }
        });

    } catch (err) {
        console.error("Error in /log:", err);
        return res.status(500).json({ success: false, message: 'Server error', error: err.message });
    }
});
// -----------------------------------------------------
//  BACKFILL BAROMETRIC DATA FOR EXISTING ROWS
//  Uses Open-Meteo archive API and your existing helpers
// -----------------------------------------------------
app.get('/backfill-barometric', async (req, res) => {
    try {
        // Grab only rows that are missing some barometric info but have lat/lon + date + time
        const [rows] = await db.query(`
            SELECT 
                id, date, time, latitude, longitude,
                barometric_current, barometric_prev3h, barometric_pressure_trend
            FROM fishing_entries
            WHERE (barometric_current IS NULL 
                   OR barometric_prev3h IS NULL 
                   OR barometric_pressure_trend IS NULL)
              AND latitude IS NOT NULL
              AND longitude IS NOT NULL
              AND date IS NOT NULL
              AND time IS NOT NULL
        `);

        if (rows.length === 0) {
            return res.json({
                success: true,
                updated_rows: 0,
                message: "No rows need barometric backfill."
            });
        }

        let updated = 0;

        // Simple cache so we don't re-call the API for the same lat/lon/date
        const baroCache = new Map(); // key: `${lat}|${lon}|${dateStr}`

        for (const row of rows) {
            const {
                id,
                date,
                time,
                latitude,
                longitude,
                barometric_current,
                barometric_prev3h,
                barometric_pressure_trend
            } = row;

            if (!latitude || !longitude || !date || !time) continue;

            // Normalize date + time to strings
            const dateStr = date instanceof Date
                ? date.toISOString().split("T")[0]
                : date; // should already be 'YYYY-MM-DD'

            const timeStr = time instanceof Date
                ? time.toTimeString().slice(0, 8)
                : time; // should already be 'HH:MM:SS'

            const catchDateTime = new Date(`${dateStr}T${timeStr}`);
            const prev3hDateTime = new Date(catchDateTime.getTime() - 3 * 60 * 60 * 1000);

            // Fetch / reuse barometric data for that lat/lon/date
            const cacheKey = `${latitude}|${longitude}|${dateStr}`;
            let baroData = baroCache.get(cacheKey);

            if (!baroData) {
                baroData = await fetchBarometricData(latitude, longitude, dateStr);
                if (!baroData) {
                    console.warn(`No barometric data for row id=${id}, date=${dateStr}`);
                    continue;
                }
                baroCache.set(cacheKey, baroData);
            }

            // Compute nearest pressure values
            const apiCurrent = getNearestPressure(baroData, catchDateTime);
            const apiPrev3h = getNearestPressure(baroData, prev3hDateTime);

            // If still nothing, skip row
            if (apiCurrent == null && apiPrev3h == null) {
                console.warn(`No usable pressure points for row id=${id}`);
                continue;
            }

            // Decide final values to store:
            // - if DB already has something, keep it unless it's NULL
            const finalCurrent = barometric_current != null
                ? barometric_current
                : (apiCurrent != null ? apiCurrent : null);

            const finalPrev3h = barometric_prev3h != null
                ? barometric_prev3h
                : (apiPrev3h != null ? apiPrev3h : null);

            const finalTrend = barometric_pressure_trend != null
                ? barometric_pressure_trend
                : calculateBaroTrend(finalCurrent, finalPrev3h);

            await db.query(
                `
                UPDATE fishing_entries
                SET 
                    barometric_current = ?,
                    barometric_prev3h = ?,
                    barometric_pressure_trend = ?
                WHERE id = ?
                `,
                [
                    finalCurrent,
                    finalPrev3h,
                    finalTrend,
                    id
                ]
            );

            updated++;
        }

        return res.json({
            success: true,
            updated_rows: updated,
            message: `Barometric data updated for ${updated} row(s).`
        });

    } catch (err) {
        console.error("Backfill barometric error:", err);
        return res.status(500).json({
            success: false,
            message: "Barometric backfill failed",
            error: err.message
        });
    }
});

// ====== HEALTH CHECK ======
app.get("/", (req, res) => {
    res.send("Server is running!");
});

// ====== START SERVER ======
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
