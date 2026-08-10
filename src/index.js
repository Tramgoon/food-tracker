require('dotenv').config();

const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3100);
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'food-tracker.sqlite');
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN || '';

const app = express();
const db = new Database(DATABASE_PATH);

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack']);
const SOURCES = new Set(['me', 'agent']);
const CONFIG_KEYS = new Set([
  'calorie_target',
  'protein_target',
  'carb_target',
  'fat_target',
  'starting_weight',
  'target_weight',
  'activity_level',
]);
const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
};

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    calories REAL NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    meal_type TEXT NOT NULL DEFAULT 'snack',
    date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'me',
    created_at TEXT NOT NULL,
    CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    CHECK (source IN ('me', 'agent'))
  );

  CREATE TABLE IF NOT EXISTS weight_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    weight REAL NOT NULL,
    date TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'me',
    created_at TEXT NOT NULL,
    CHECK (source IN ('me', 'agent'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_foods_date ON foods(date);
  CREATE INDEX IF NOT EXISTS idx_weight_log_date ON weight_log(date);
`);

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function numberValue(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function configNumber(config, key) {
  if (!config[key]) return null;
  const n = Number(config[key]);
  return Number.isFinite(n) ? n : null;
}

function getCalorieTarget(config) {
  const explicit = configNumber(config, 'calorie_target');
  if (explicit !== null) return Math.round(explicit);

  const startingWeight = configNumber(config, 'starting_weight');
  const activity = config.activity_level || 'sedentary';
  const multiplier = ACTIVITY_MULTIPLIERS[activity] || ACTIVITY_MULTIPLIERS.sedentary;
  if (startingWeight === null) return 2000;

  return Math.max(0, Math.round(startingWeight * 2.2 * 11 * multiplier - 500));
}

function getDailyTotals(date) {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(calories), 0) AS calories,
      COALESCE(SUM(protein), 0) AS protein,
      COALESCE(SUM(carbs), 0) AS carbs,
      COALESCE(SUM(fat), 0) AS fat
    FROM foods
    WHERE date = ?
  `).get(date);

  return {
    calories: Number(totals.calories || 0),
    protein: Number(totals.protein || 0),
    carbs: Number(totals.carbs || 0),
    fat: Number(totals.fat || 0),
  };
}

function averageWeight(rows) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + row.weight, 0) / rows.length;
}

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function getWeightSection(config) {
  const latest = db.prepare('SELECT * FROM weight_log ORDER BY date DESC LIMIT 1').get();
  if (!latest) {
    return {
      latest: null,
      average7: null,
      trend: null,
      target: configNumber(config, 'target_weight'),
      predicted_date: null,
      prediction_note: 'Log weight for at least two weeks to estimate a target date.',
    };
  }

  const recent = db.prepare('SELECT * FROM weight_log ORDER BY date DESC LIMIT 14').all();
  const last7 = recent.slice(0, 7).reverse();
  const previous7 = recent.slice(7, 14).reverse();
  const avg7 = averageWeight(last7);
  const previousAvg7 = averageWeight(previous7);
  const delta = avg7 !== null && previousAvg7 !== null ? avg7 - previousAvg7 : null;
  const trend = delta === null || Math.abs(delta) < 0.1 ? 'stable' : delta > 0 ? 'up' : 'down';
  const target = configNumber(config, 'target_weight');

  let predictedDate = null;
  let predictionNote = 'Set a target weight and keep logging to estimate a target date.';
  if (target !== null && avg7 !== null && previousAvg7 !== null && Math.abs(delta) >= 0.1) {
    const directionNeeded = target - avg7;
    const weeklyChange = delta;
    if ((directionNeeded < 0 && weeklyChange < 0) || (directionNeeded > 0 && weeklyChange > 0)) {
      const weeks = Math.abs(directionNeeded / weeklyChange);
      predictedDate = addDays(todayISO(), Math.ceil(weeks * 7));
      predictionNote = `Estimated from the current 7-day average trend of ${weeklyChange.toFixed(2)} per week.`;
    } else {
      predictionNote = 'Your current trend is not moving toward the target.';
    }
  }

  return {
    latest: { ...latest, weight: Number(latest.weight) },
    average7: avg7,
    trend,
    target,
    predicted_date: predictedDate,
    prediction_note: predictionNote,
  };
}

function getInsights(config) {
  const calorieRows = db.prepare(`
    SELECT date, COALESCE(SUM(calories), 0) AS calories,
           COALESCE(SUM(protein), 0) AS protein
    FROM foods
    WHERE date >= date('now', '-29 days')
    GROUP BY date
    ORDER BY date ASC
  `).all();

  const last14 = db.prepare(`
    SELECT date, COALESCE(SUM(calories), 0) AS calories
    FROM foods
    WHERE date >= date('now', '-13 days')
    GROUP BY date
    ORDER BY date ASC
  `).all();

  const weight30 = db.prepare(`
    SELECT date, weight
    FROM weight_log
    WHERE date >= date('now', '-29 days')
    ORDER BY date ASC
  `).all();

  const last7 = calorieRows.filter((row) => row.date >= addDays(todayISO(), -6));
  const avg7 = last7.length ? last7.reduce((sum, row) => sum + row.calories, 0) / last7.length : 0;
  const avg30 = calorieRows.length ? calorieRows.reduce((sum, row) => sum + row.calories, 0) / calorieRows.length : 0;
  const daysLogged = db.prepare('SELECT COUNT(DISTINCT date) AS count FROM foods').get().count;
  const loggedDates = new Set(db.prepare('SELECT DISTINCT date FROM foods ORDER BY date DESC').all().map((row) => row.date));
  let streak = 0;
  for (let date = todayISO(); loggedDates.has(date); date = addDays(date, -1)) streak += 1;

  const weekend = calorieRows.filter((row) => [0, 6].includes(new Date(`${row.date}T00:00:00Z`).getUTCDay()));
  const weekday = calorieRows.filter((row) => ![0, 6].includes(new Date(`${row.date}T00:00:00Z`).getUTCDay()));
  const weekendAvg = weekend.length ? weekend.reduce((sum, row) => sum + row.calories, 0) / weekend.length : 0;
  const weekdayAvg = weekday.length ? weekday.reduce((sum, row) => sum + row.calories, 0) / weekday.length : 0;
  const proteinTarget = configNumber(config, 'protein_target') || 0;
  const weekdayProteinAvg = weekday.length ? weekday.reduce((sum, row) => sum + row.protein, 0) / weekday.length : 0;

  let text = 'Log a few more days to unlock stronger pattern detection.';
  if (weekend.length >= 2 && weekday.length >= 3 && weekendAvg > weekdayAvg * 1.15) {
    text = 'You consistently eat more on weekends.';
  } else if (proteinTarget > 0 && weekday.length >= 3 && weekdayProteinAvg < proteinTarget * 0.8) {
    text = 'Your protein intake is below target on weekdays.';
  } else if (calorieRows.length >= 5 && avg7 > getCalorieTarget(config)) {
    text = 'Your recent calorie average is above target.';
  } else if (calorieRows.length >= 5) {
    text = 'Your recent intake is tracking near your configured target.';
  }

  return {
    calorie_chart: last14.map((row) => ({ date: row.date, calories: Number(row.calories || 0) })),
    weight_chart: weight30.map((row) => ({ date: row.date, weight: Number(row.weight) })),
    stats: {
      average_calories_7d: Math.round(avg7),
      average_calories_30d: Math.round(avg30),
      days_logged: daysLogged,
      current_streak: streak,
    },
    text,
  };
}

function groupFoods(rows) {
  return ['breakfast', 'lunch', 'dinner', 'snack'].reduce((groups, meal) => {
    groups[meal] = rows.filter((row) => row.meal_type === meal);
    return groups;
  }, {});
}

function getSummary() {
  const date = todayISO();
  const config = readConfig();
  const todayFoods = db.prepare('SELECT * FROM foods WHERE date = ? ORDER BY created_at ASC, id ASC').all(date);
  const totals = getDailyTotals(date);
  const targets = {
    calories: getCalorieTarget(config),
    protein: configNumber(config, 'protein_target') || 0,
    carbs: configNumber(config, 'carb_target') || 0,
    fat: configNumber(config, 'fat_target') || 0,
  };

  return {
    date,
    foods_by_meal: groupFoods(todayFoods),
    totals,
    targets,
    remaining_calories: targets.calories - totals.calories,
    weight: getWeightSection(config),
    config,
    insights: getInsights(config),
  };
}

function getState() {
  const date = todayISO();
  return {
    summary: getSummary(),
    today_foods: db.prepare('SELECT * FROM foods WHERE date = ? ORDER BY created_at ASC, id ASC').all(date),
    weight_history: db.prepare('SELECT * FROM weight_log ORDER BY date DESC LIMIT 90').all(),
    config: readConfig(),
  };
}

function requireAgent(req, res, next) {
  const header = req.get('authorization') || '';
  const expected = `Bearer ${AGENT_API_TOKEN}`;
  if (!AGENT_API_TOKEN || header !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function validateFood(body) {
  const description = String(body.description || '').trim();
  const mealType = body.meal_type || 'snack';
  const date = body.date || todayISO();
  if (!description) return { error: 'description is required' };
  if (!MEAL_TYPES.has(mealType)) return { error: 'invalid meal_type' };
  if (!isDate(date)) return { error: 'invalid date' };
  return {
    description,
    calories: numberValue(body.calories),
    protein: numberValue(body.protein),
    carbs: numberValue(body.carbs),
    fat: numberValue(body.fat),
    meal_type: mealType,
    date,
  };
}

function insertFood(body, source) {
  if (!SOURCES.has(source)) throw new Error('invalid source');
  const food = validateFood(body);
  if (food.error) return food;
  const result = db.prepare(`
    INSERT INTO foods (description, calories, protein, carbs, fat, meal_type, date, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(food.description, food.calories, food.protein, food.carbs, food.fat, food.meal_type, food.date, source, nowISO());
  return db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid);
}

function upsertWeight(body, source) {
  if (!SOURCES.has(source)) throw new Error('invalid source');
  const weight = numberValue(body.weight, NaN);
  const date = body.date || todayISO();
  if (!Number.isFinite(weight) || weight <= 0) return { error: 'valid weight is required' };
  if (!isDate(date)) return { error: 'invalid date' };
  db.prepare(`
    INSERT INTO weight_log (weight, date, source, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      weight = excluded.weight,
      source = excluded.source,
      created_at = excluded.created_at
  `).run(weight, date, source, nowISO());
  return db.prepare('SELECT * FROM weight_log WHERE date = ?').get(date);
}

app.get('/api/summary', requireAgent, (req, res) => {
  res.json(getSummary());
});

app.post('/api/food', requireAgent, (req, res) => {
  const food = insertFood(req.body, 'agent');
  if (food.error) return res.status(400).json(food);
  res.status(201).json({ food, summary: getSummary() });
});

app.post('/api/weight', requireAgent, (req, res) => {
  const weight = upsertWeight(req.body, 'agent');
  if (weight.error) return res.status(400).json(weight);
  res.status(201).json({ weight, summary: getSummary() });
});

app.get('/api/state', (req, res) => {
  res.json(getState());
});

app.post('/api/food-web', (req, res) => {
  const food = insertFood(req.body, 'me');
  if (food.error) return res.status(400).json(food);
  res.status(201).json({ food, state: getState() });
});

app.delete('/api/food-web/:id', (req, res) => {
  const result = db.prepare('DELETE FROM foods WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'food not found' });
  res.json({ ok: true, state: getState() });
});

app.post('/api/weight-web', (req, res) => {
  const weight = upsertWeight(req.body, 'me');
  if (weight.error) return res.status(400).json(weight);
  res.status(201).json({ weight, state: getState() });
});

app.post('/api/config', (req, res) => {
  const key = String(req.body.key || '').trim();
  if (!CONFIG_KEYS.has(key)) return res.status(400).json({ error: 'invalid config key' });
  let value = String(req.body.value ?? '').trim();
  if (key === 'activity_level' && !ACTIVITY_MULTIPLIERS[value]) {
    return res.status(400).json({ error: 'invalid activity_level' });
  }
  if (key !== 'activity_level') {
    if (value === '') {
      db.prepare('DELETE FROM config WHERE key = ?').run(key);
      return res.json({ config: readConfig(), state: getState() });
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'value must be a positive number' });
    value = String(n);
  }
  db.prepare(`
    INSERT INTO config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
  res.json({ config: readConfig(), state: getState() });
});

const server = app.listen(PORT, () => {
  console.log(`Food tracker listening on http://localhost:${PORT}`);
  console.log(`Database: ${DATABASE_PATH}`);
});

process.on('SIGTERM', () => server.close(() => db.close()));
