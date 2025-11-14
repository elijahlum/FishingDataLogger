const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

// MySQL connection
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',          
    password: 'Lani0143!!@@', 
    database: 'fishing_log'
});

db.connect(err => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
    } else {
        console.log('Connected to MySQL');
    }
});

// Function to calculate barometric trend
function calculateBaroTrend(current, sixHoursAgo) {
    if (!current || !sixHoursAgo) return "";
    const diff = parseFloat(current) - parseFloat(sixHoursAgo);
    if (diff > 0) return "Rising";
    if (diff < 0) return "Falling";
    return "Steady";
}

// POST endpoint to add a new log entry
app.post('/log', (req, res) => {
    try {
        const {
            title, date, time, latitude, longitude, area_name,
            weather_temp, weather_condition, tide_stage, moon_phase,
            barometric_current, barometric_6hrs_ago, catch_status
        } = req.body;

        // This must be declared AFTER destructuring
        const barometric_pressure_trend = calculateBaroTrend(barometric_current, barometric_6hrs_ago);

        const query = `
            INSERT INTO fishing_entries
            (title, date, time, latitude, longitude, area_name,
             weather_temp, weather_condition, tide_stage, moon_phase,
             barometric_current, barometric_6hrs_ago, barometric_pressure_trend, catch_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(query, [
            title, date, time, latitude || null, longitude || null, area_name || null,
            weather_temp || null, weather_condition || null, tide_stage || null, moon_phase || null,
            barometric_current || null, barometric_6hrs_ago || null, barometric_pressure_trend, catch_status
        ], (err, result) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ success: false, message: 'Database error' });
            }

            res.json({ success: true, id: result.insertId });
        });

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


// Test GET endpoint
app.get("/", (req, res) => {
    res.send("Server is running!");
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
