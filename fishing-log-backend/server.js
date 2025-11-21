const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 3000;

// ====== CONFIG ======
const API_KEY = "3264359d276642dea6bdb95366fb8896";
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
function calculateBaroTrend(current, sixHoursAgo) {
    if (!current || !sixHoursAgo) return null;
    const diff = parseFloat(current) - parseFloat(sixHoursAgo);
    if (diff > 0) return "Rising";
    if (diff < 0) return "Falling";
    return "Steady";
}

// ====== FETCH ASTRONOMY (IPGEO ONLY) ======
async function fetchAstronomyData(lat, lon, date) {
    try {
        const formattedDate = new Date(date).toISOString().split("T")[0];

        const url = `https://api.ipgeolocation.io/astronomy?apiKey=${IPGEO_KEY}&lat=${lat}&long=${lon}&date=${formattedDate}`;

        console.log("ASTRO FETCH URL:", url);

        const res = await axios.get(url);
        const data = res.data;

        // Convert the API's `moon_phase` into our DB column name
        data.moon_phase_name = data.moon_phase || null;

        return data;
    } catch (err) {
        console.error("Astronomy API error:", err.message);
        return null;
    }
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
            weather_temp,
            weather_condition,
            tide_stage,
            barometric_current,
            barometric_6hrs_ago,
            tide_station_id_used,
            catch_status
        } = req.body;

        if (!title || !date || !time || catch_status === undefined) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        const barometric_pressure_trend = calculateBaroTrend(barometric_current, barometric_6hrs_ago);

        let astro = null;
        if (latitude && longitude) {
            astro = await fetchAstronomyData(latitude, longitude, date);
        }

        const sql = `
            INSERT INTO fishing_entries 
            (title, date, time, latitude, longitude, area_name,
             weather_temp, weather_condition, tide_stage,
             barometric_current, barometric_6hrs_ago, barometric_pressure_trend,
             tide_station_id_used, catch_status,
             sunrise, sunset, moonrise, moonset, moon_phase_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const values = [
            title, date, time, latitude || null, longitude || null, area_name || null,
            weather_temp || null, weather_condition || null, tide_stage || null,
            barometric_current || null, barometric_6hrs_ago || null, barometric_pressure_trend,
            tide_station_id_used || null, catch_status,
            astro?.sunrise || null,
            astro?.sunset || null,
            astro?.moonrise || null,
            astro?.moonset || null,
            astro?.moon_phase_name || null
        ];

        const [result] = await db.query(sql, values);

        return res.json({
            success: true,
            id: result.insertId,
            astro
        });

    } catch (err) {
        console.error("Error in /log:", err);
        return res.status(500).json({ success: false, message: "Server error", error: err.message });
    }
});

// ====== BACKFILL ASTRONOMY ======
// -----------------------------------------------------
//  BACKFILL ASTRONOMY FOR EXISTING ROWS (SINGLE COLUMN VERSION)
// -----------------------------------------------------
app.get('/backfill-astronomy', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT id, date, latitude, longitude
            FROM fishing_entries
            WHERE sunrise IS NULL 
               OR sunset IS NULL
               OR moonrise IS NULL
               OR moonset IS NULL
               OR moon_phase_name IS NULL
        `);

        if (rows.length === 0) {
            return res.json({ success: true, message: "No rows need updating.", updated_rows: 0 });
        }

        let updated = 0;

        for (const row of rows) {
            const { id, date, latitude, longitude } = row;

            if (!latitude || !longitude) continue;

            const astro = await fetchAstronomyData(latitude, longitude, date);
            if (!astro) continue;

            const moonPhaseName = astro.moon_phase_name || null;

            await db.query(`
                UPDATE fishing_entries SET
                    sunrise = ?,
                    sunset = ?,
                    moonrise = ?,
                    moonset = ?,
                    moon_phase_name = ?
                WHERE id = ?
            `, [
                astro.sunrise,
                astro.sunset,
                astro.moonrise,
                astro.moonset,
                moonPhaseName,
                id
            ]);

            updated++;
        }

        return res.json({
            success: true,
            updated_rows: updated,
            message: `Astronomy data updated for ${updated} rows.`
        });

    } catch (err) {
        console.error("Backfill error:", err);
        return res.status(500).json({ success: false, message: "Backfill failed", error: err.message });
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
