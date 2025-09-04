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
    user: 'root',          // replace with your MySQL username
    password: 'Lani0143!!@@', // replace with your MySQL password
    database: 'fishing_log'
});

db.connect(err => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
    } else {
        console.log('Connected to MySQL');
    }
});

// Endpoint to add a new log entry
app.post('/log', (req, res) => {
    const {
        title, date, time, latitude, longitude, area_name,
        weather_temp, weather_condition, tide_station_id_used,
        tide_stage, moon_phase, barometric_current,
        barometric_6hrs_ago
    } = req.body;

    const query = `
        INSERT INTO logs 
        (title, date, time, latitude, longitude, area_name, weather_temp, weather_condition, 
         tide_station_id_used, tide_stage, moon_phase, barometric_current, barometric_6hrs_ago, barometric_pressure_trend)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [
        title, date, time, latitude, longitude, area_name,
        weather_temp, weather_condition, tide_station_id_used,
        tide_stage, moon_phase, barometric_current,
        barometric_6hrs_ago, barometric_pressure_trend
    ], (err, result) => {
        if (err) {
            console.error(err);
            res.status(500).send({ success: false, message: 'Database error' });
        } else {
            res.send({ success: true, id: result.insertId });
        }
    });
});
// Test GET endpoint
app.get("/", (req, res) => {
    res.send("Server is running!");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
