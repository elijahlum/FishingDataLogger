const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

// ====== DYNAMIC TIDE STATIONS (NOAA MDAPI) ======
let TIDE_STATIONS = []; // will be populated at startup

async function loadTideStations() {
    try {
        // All tide-prediction stations (worldwide, but mostly US + territories)
        const url = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions&units=english";
        console.log("Loading tide stations from NOAA MDAPI...");
        const res = await axios.get(url);

        const list = res.data?.stationList || res.data?.stations || [];
        TIDE_STATIONS = list
            .map(s => ({
                id: s.id,
                name: s.name,
                lat: parseFloat(s.lat),
                lon: parseFloat(s.lng),
                state: s.state
            }))
            .filter(s => !Number.isNaN(s.lat) && !Number.isNaN(s.lon));

        console.log(`Loaded ${TIDE_STATIONS.length} tide-prediction stations from NOAA.`);
    } catch (err) {
        console.error("Failed to load tide stations from NOAA MDAPI:", err.message);
        // You *could* optionally fall back to a small hard-coded list here if you want
    }
}
// ====== GEO HELPERS (Haversine + nearest station) ======
function toRad(deg) {
    return (deg * Math.PI) / 180;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function findNearestTideStation(lat, lon) {
    if (!lat || !lon || !TIDE_STATIONS.length) return null;

    let best = null;
    let bestDist = Infinity;

    for (const st of TIDE_STATIONS) {
        const d = haversineDistance(lat, lon, st.lat, st.lon);
        if (d < bestDist) {
            bestDist = d;
            best = st;
        }
    }
    return best;
}
// ====== NOAA TIDE HELPERS ======
const NOAA_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

function formatDateYYYYMMDD(date) {
    // If it's already a YYYY-MM-DD string, just strip the dashes
    if (typeof date === "string") {
        const parts = date.split("-");
        if (parts.length === 3) {
            const [y, m, d] = parts;
            return `${y}${m}${d}`;
        }
    }

    // Fallback for Date objects or other inputs
    const dObj = (date instanceof Date) ? date : new Date(date);
    const y = dObj.getFullYear();
    const m = String(dObj.getMonth() + 1).padStart(2, "0");
    const day = String(dObj.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
}

function parseNoaaTime(localString) {
    // NOAA returns "YYYY-MM-DD HH:mm"
    return new Date(localString.replace(" ", "T") + ":00");
}

// High/low extremes for the day
async function fetchTidePredictionsHilo(stationId, date) {
    if (!stationId || !date) return [];

    const dateStr = formatDateYYYYMMDD(date);
    const url =
        `${NOAA_BASE}?product=predictions` +
        `&application=fishing-trip-logger` +
        `&begin_date=${dateStr}` +
        `&end_date=${dateStr}` +
        `&datum=MLLW` +
        `&station=${encodeURIComponent(stationId)}` +
        `&time_zone=lst_ldt` +
        `&units=english` +
        `&interval=hilo` +
        `&format=json`;

    console.log("TIDE HILO URL:", url);

    const res = await axios.get(url);
    return res.data?.predictions || [];
}

// 6-minute prediction series
async function fetchTidePredictionsSixMin(stationId, date) {
    if (!stationId || !date) return [];

    const dateStr = formatDateYYYYMMDD(date);
    const url =
        `${NOAA_BASE}?product=predictions` +
        `&application=fishing-trip-logger` +
        `&begin_date=${dateStr}` +
        `&end_date=${dateStr}` +
        `&datum=MLLW` +
        `&station=${encodeURIComponent(stationId)}` +
        `&time_zone=lst_ldt` +
        `&units=english` +
        `&interval=6` +
        `&format=json`;

    console.log("TIDE 6-MIN URL:", url);

    const res = await axios.get(url);
    return res.data?.predictions || [];
}

function getTideStageAndRateAtTime(catchDateTime, hiloPreds, sixPreds) {
    if (!catchDateTime) return null;

    const catchTs = catchDateTime.getTime();
    const SLACK_THRESHOLD_RATE = 0.1;       // ft/hr, for dense data
    const SLACK_WINDOW_MIN = 20;            // minutes window around highs/lows for slack

    // ---------- 1) Prefer dense 6-minute predictions if available ----------
    if (sixPreds && sixPreds.length >= 2) {
        const samples = sixPreds.map(p => ({
            time: parseNoaaTime(p.t),
            height: parseFloat(p.v)
        })).sort((a, b) => a.time - b.time);

        let segIdx = -1;
        for (let i = 0; i < samples.length - 1; i++) {
            const t1 = samples[i].time.getTime();
            const t2 = samples[i + 1].time.getTime();
            if (t1 <= catchTs && catchTs <= t2) {
                segIdx = i;
                break;
            }
        }

        if (segIdx === -1) {
            segIdx = samples.length - 2;
        }

        const s1 = samples[segIdx];
        const s2 = samples[segIdx + 1];
        const dtHours = (s2.time.getTime() - s1.time.getTime()) / (1000 * 60 * 60);
        const dh = s2.height - s1.height;
        const rateFtPerHour = dtHours !== 0 ? (dh / dtHours) : 0;

        const denomMs = (s2.time.getTime() - s1.time.getTime());
        const alpha = denomMs !== 0
            ? (catchTs - s1.time.getTime()) / denomMs
            : 0;
        const tideHeightFt = s1.height + alpha * dh;

        const absRate = Math.abs(rateFtPerHour);

        let stage = "Unknown";
        if (absRate < SLACK_THRESHOLD_RATE) {
            stage = "Slack";
        } else if (rateFtPerHour > 0) {
            stage = "Rising";
        } else if (rateFtPerHour < 0) {
            stage = "Dropping";
        }

        let nearestExtreme = null;
        let nearestExtremeMinutes = null;

        if (hiloPreds && hiloPreds.length) {
            for (const p of hiloPreds) {
                const t = parseNoaaTime(p.t).getTime();
                const mins = Math.abs(t - catchTs) / (1000 * 60);
                if (nearestExtreme == null || mins < nearestExtremeMinutes) {
                    nearestExtreme = p;
                    nearestExtremeMinutes = mins;
                }
            }
        }

        return {
            autoStage: stage,
            tideHeightFt,
            tideRateFtPerHour: rateFtPerHour,
            nearestExtremeType: nearestExtreme?.type || null,
            nearestExtremeMinutes
        };
    }

    // ---------- 2) Fallback: only high/low predictions (subordinate stations) ----------
    if (!hiloPreds || hiloPreds.length < 2) {
        return null;
    }

    const extremes = hiloPreds.map(p => ({
        time: parseNoaaTime(p.t),
        height: parseFloat(p.v),
        type: p.type  // 'H' or 'L'
    })).sort((a, b) => a.time - b.time);

    // Find the two bracketing extremes around catch time
    let prev = null;
    let next = null;

    for (let i = 0; i < extremes.length; i++) {
        const t = extremes[i].time.getTime();
        if (t <= catchTs) {
            prev = extremes[i];
        }
        if (t > catchTs) {
            next = extremes[i];
            break;
        }
    }

    // If catch is before first or after last, just use nearest two
    if (!prev) {
        prev = extremes[0];
        next = extremes[1] || extremes[0];
    } else if (!next) {
        next = extremes[extremes.length - 1];
        // If still same as prev (weird case), just bail
        if (next.time.getTime() === prev.time.getTime()) {
            return null;
        }
    }

    const minutesFromPrev = (catchTs - prev.time.getTime()) / (1000 * 60);
    const minutesToNext = (next.time.getTime() - catchTs) / (1000 * 60);

    // Stage based on where we are between Low and High
    let stage = "Unknown";

    // Slack near the high/low times
    if (Math.abs(minutesFromPrev) <= SLACK_WINDOW_MIN || Math.abs(minutesToNext) <= SLACK_WINDOW_MIN) {
        stage = "Slack";
    } else if (prev.type === "L" && next.type === "H") {
        // Flooding (rising) between a low and the next high
        stage = "Rising";
    } else if (prev.type === "H" && next.type === "L") {
        // Ebbing (dropping) between a high and the next low
        stage = "Dropping";
    }

    const hoursBetween = (next.time.getTime() - prev.time.getTime()) / (1000 * 60 * 60) || 1;
    const dh = next.height - prev.height;
    const rateFtPerHour = dh / hoursBetween;

    const segmentMs = (next.time.getTime() - prev.time.getTime());
    const alpha = segmentMs !== 0
        ? (catchTs - prev.time.getTime()) / segmentMs
        : 0;
    const tideHeightFt = prev.height + alpha * dh;

    // Nearest extreme info
    let nearestExtreme = prev;
    let nearestExtremeMinutes = Math.abs(minutesFromPrev);
    const nextMinsAbs = Math.abs(minutesToNext);
    if (nextMinsAbs < nearestExtremeMinutes) {
        nearestExtreme = next;
        nearestExtremeMinutes = nextMinsAbs;
    }

    return {
        autoStage: stage,
        tideHeightFt,
        tideRateFtPerHour: rateFtPerHour,
        nearestExtremeType: nearestExtreme.type,
        nearestExtremeMinutes
    };
}



// ====== CONFIG ======
const IPGEO_KEY = process.env.IPGEO_KEY || "3264359d276642dea6bdb95366fb8896";

// ====== MIDDLEWARE ======
app.use(cors());
app.use(bodyParser.json());

// Serve frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

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

    await loadTideStations(); // load up the tide stations
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

// ====== WEATHER CODE → DESCRIPTION (OPEN-METEO WMO) ======
function weatherCodeToDescription(code) {
    if (code === null || code === undefined) return null;
    const c = Number(code);

    if (c === 0) return "Clear";
    if (c === 1 || c === 2) return "Partly Cloudy";
    if (c === 3) return "Overcast";

    if (c === 45 || c === 48) return "Fog";
    if (c === 51 || c === 53 || c === 55) return "Drizzle";
    if (c === 56 || c === 57) return "Freezing Drizzle";

    if (c === 61 || c === 63 || c === 65) return "Rain";
    if (c === 66 || c === 67) return "Freezing Rain";

    if (c === 71 || c === 73 || c === 75) return "Snow";
    if (c === 77) return "Snow Grains";

    if (c === 80 || c === 81 || c === 82) return "Rain Showers";
    if (c === 85 || c === 86) return "Snow Showers";

    if (c === 95) return "Thunderstorm";
    if (c === 96 || c === 99) return "Thunderstorm with Hail";

    return "Unknown";
}

// Normalize astronomy times: convert "-:-" / "-" / empty to null
function normalizeAstroTime(t) {
    if (!t) return null;
    const s = String(t).trim();
    if (s === '' || s === '-:-' || s === '-') return null;
    return s; // e.g. "07:05" is fine for MySQL TIME
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

// ====== FETCH WEATHER (OPEN-METEO ARCHIVE) ======
async function fetchWeatherData(lat, lon, date) {
    try {
        if (!lat || !lon || !date) return null;

        const formattedDate = new Date(date).toISOString().split("T")[0];

        // temperature_2m in Fahrenheit + weathercode for condition
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
            `&hourly=temperature_2m,weathercode&start_date=${formattedDate}&end_date=${formattedDate}` +
            `&timezone=America/Los_Angeles&temperature_unit=fahrenheit`;

        console.log("WEATHER FETCH URL:", url);

        const res = await axios.get(url);
        return res.data;
    } catch (err) {
        console.error("Weather API error:", err.message);
        return null;
    }
}

// Find nearest hourly weather to a target Date object
function getNearestWeather(data, targetDate) {
    if (!data || !data.hourly || !data.hourly.time || !data.hourly.temperature_2m || !data.hourly.weathercode) {
        return null;
    }

    const times = data.hourly.time;             // ["2025-09-21T00:00", ...]
    const temps = data.hourly.temperature_2m;   // [55.3, 54.8, ...]
    const codes = data.hourly.weathercode;      // [0, 1, 2, ...]

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

    return {
        tempF: temps[bestIdx],
        weatherCode: codes[bestIdx]
    };
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
        console.log(">>> /log hit, body:", req.body);
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
        // ----- TIDE LOOKUP (NOAA, dynamic stations) -----
        let tideStationUsed = tide_station_id_used || null;
        let tideStageAuto = tide_stage || null;  // prefer manual if you type one
        let tideHeightFt = null;
        let tideRateFtPerHour = null;

        if (latitude && longitude && date && time) {
            const catchDateTime = new Date(`${date}T${time}`);

            const nearestStation = findNearestTideStation(
                parseFloat(latitude),
                parseFloat(longitude)
            );

            if (nearestStation) {
                tideStationUsed = nearestStation.id;

                try {
                    const [hiloPreds, sixPreds] = await Promise.all([
                        fetchTidePredictionsHilo(nearestStation.id, date),
                        fetchTidePredictionsSixMin(nearestStation.id, date)
                    ]);

                    const tideInfo = getTideStageAndRateAtTime(
                        catchDateTime,
                        hiloPreds,
                        sixPreds
                    );

                    if (tideInfo) {
                        // if user didn’t manually set tide_stage, autofill
                        tideStageAuto = tideStageAuto || tideInfo.autoStage;
                        tideHeightFt = tideInfo.tideHeightFt;
                        tideRateFtPerHour = tideInfo.tideRateFtPerHour;
                    }
                } catch (e) {
                    console.error("Tide API error:", e.message);
                }
            }
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
        // ----- WEATHER LOOKUP (if not supplied manually) -----
        let finalWeatherTemp = weather_temp || null;
        let finalWeatherCondition = weather_condition || null;

        if ((!finalWeatherTemp || !finalWeatherCondition) && latitude && longitude) {
            const weatherData = await fetchWeatherData(latitude, longitude, date);
            if (weatherData) {
                const catchDateTime = new Date(`${date}T${time}`);
                const nearest = getNearestWeather(weatherData, catchDateTime);
                if (nearest) {
                    if (!finalWeatherTemp) {
                        // round to nearest integer Fahrenheit, store as string
                        finalWeatherTemp = Math.round(nearest.tempF).toString();
                    }
                    if (!finalWeatherCondition) {
                        finalWeatherCondition = weatherCodeToDescription(nearest.weatherCode);
                        // normalize "Sunny" → "Clear" like you wanted
                        if (finalWeatherCondition === "Sunny") {
                            finalWeatherCondition = "Clear";
                        }
                    }
                }
            }
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
            sunrise, sunset, moonrise, moonset, moon_phase_name,
            tide_height_ft, tide_rate_ft_per_hr)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const values = [
            title, date, time, latitude || null, longitude || null, area_name || null,
            species || null, technique || null, hatchery_wild || null,
            finalWeatherTemp, finalWeatherCondition, tideStageAuto || null,
            baroCurrentVal, baroPrevVal, barometric_pressure_trend,
            tideStationUsed || null, catch_status,
            normalizeAstroTime(astro?.sunrise),
            normalizeAstroTime(astro?.sunset),
            normalizeAstroTime(astro?.moonrise),
            normalizeAstroTime(astro?.moonset),
            moonPhaseName,
            tideHeightFt,
            tideRateFtPerHour
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
            },
            tide: {
                tide_stage: tideStageAuto,
                tide_station_id_used: tideStationUsed,
                tide_height_ft: tideHeightFt,
                tide_rate_ft_per_hr: tideRateFtPerHour
            },
            weather_temp: finalWeatherTemp,
            weather_condition: finalWeatherCondition
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
// -----------------------------------------------------
//  BACKFILL TIDE DATA FOR EXISTING ROWS
//  Uses NOAA predictions + your tide helpers
// -----------------------------------------------------
app.get('/backfill-tides', async (req, res) => {
    try {
        // Grab only rows missing some tide info but with lat/lon + date + time
        const [rows] = await db.query(
            `SELECT 
                id,
                date,
                time,
                latitude,
                longitude,
                tide_stage,
                tide_station_id_used,
                tide_height_ft,
                tide_rate_ft_per_hr
                FROM fishing_entries
                WHERE latitude IS NOT NULL
              AND longitude IS NOT NULL
              AND date IS NOT NULL
              AND time IS NOT NULL`
        );


        if (rows.length === 0) {
            return res.json({
                success: true,
                updated_rows: 0,
                message: "No rows need tide backfill."
            });
        }

        let updated = 0;

        // Cache to avoid repeated NOAA calls for the same station+date
        // key: `${stationId}|${yyyyMmDd}`
        const tideCache = new Map();

        for (const row of rows) {
            const {
                id,
                date,
                time,
                latitude,
                longitude,
                tide_stage,
                tide_station_id_used,
                tide_height_ft,
                tide_rate_ft_per_hr
            } = row;

            if (!latitude || !longitude || !date || !time) continue;

            // Normalize date and time to strings
            const dateStr = date instanceof Date
                ? date.toISOString().split("T")[0]
                : date; // 'YYYY-MM-DD'

            const timeStr = time instanceof Date
                ? time.toTimeString().slice(0, 8)
                : time; // 'HH:MM:SS'

            const catchDateTime = new Date(`${dateStr}T${timeStr}`);

            // Find nearest tide station
            const nearestStation = findNearestTideStation(
                parseFloat(latitude),
                parseFloat(longitude)
            );

            if (!nearestStation) {
                console.warn(`No tide station found for row id=${id}`);
                continue;
            }

            const stationId = nearestStation.id;
            const dateKey = dateStr; // same YYYY-MM-DD string
            const cacheKey = `${stationId}|${dateKey}`;

            let cached = tideCache.get(cacheKey);
            if (!cached) {
                try {
                    const [hiloPreds, sixPreds] = await Promise.all([
                        fetchTidePredictionsHilo(stationId, dateKey),
                        fetchTidePredictionsSixMin(stationId, dateKey)
                    ]);
                    cached = { hiloPreds, sixPreds };
                    tideCache.set(cacheKey, cached);
                } catch (e) {
                    console.warn(`Tide API error for row id=${id}, station=${stationId}, date=${dateKey}:`, e.message);
                    continue;
                }
            }

            const { hiloPreds, sixPreds } = cached;
            if ((!hiloPreds || hiloPreds.length === 0) && (!sixPreds || sixPreds.length === 0)) {
                console.warn(`No tide predictions for row id=${id}, station=${stationId}, date=${dateKey}`);
                continue;
            }

            const tideInfo = getTideStageAndRateAtTime(
                catchDateTime,
                hiloPreds,
                sixPreds
            );

            if (!tideInfo) {
                console.warn(`Unable to compute tide info for row id=${id}`);
                continue;
            }

            // Decide final values: replace and fill from tideInfo
            const finalStage = tideInfo.autoStage;      // always use computed stage
            const finalStation = stationId;             // always use nearest station

            const finalHeight = tideInfo.tideHeightFt;  // always computed height
            const finalRate = tideInfo.tideRateFtPerHour; // always computed rate


            await db.query(
                `
                UPDATE fishing_entries
                SET
                    tide_stage = ?,
                    tide_station_id_used = ?,
                    tide_height_ft = ?,
                    tide_rate_ft_per_hr = ?
                WHERE id = ?
                `,
                [
                    finalStage,
                    finalStation,
                    finalHeight,
                    finalRate,
                    id
                ]
            );

            updated++;
        }

        return res.json({
            success: true,
            updated_rows: updated,
            message: `Tide data updated for ${updated} row(s).`
        });

    } catch (err) {
        console.error("Backfill tides error:", err);
        return res.status(500).json({
            success: false,
            message: "Tide backfill failed",
            error: err.message
        });
    }
});


// ====== FRONTEND / HEALTH CHECK ======
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});


// ====== START SERVER ======
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
