CREATE TABLE IF NOT EXISTS receptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    status TEXT DEFAULT '접수대기',
    owner_name TEXT,
    pet_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    symptom TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT (datetime('now', '+9 hours'))
);
