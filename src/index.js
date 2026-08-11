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
const GROCERY_CATEGORIES = ['produce', 'meat', 'dairy', 'pantry', 'frozen', 'snacks', 'drinks', 'household', 'other'];
const GROCERY_CATEGORY_VALUES = new Set([...GROCERY_CATEGORIES, 'general']);
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

  CREATE TABLE IF NOT EXISTS groceries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    quantity TEXT NOT NULL DEFAULT '1',
    category TEXT NOT NULL DEFAULT 'other',
    price REAL NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'me',
    created_at TEXT NOT NULL,
    CHECK (source IN ('me', 'agent'))
  );

  CREATE TABLE IF NOT EXISTS health_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    step_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS health_sleep (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    sleep_seconds INTEGER NOT NULL DEFAULT 0,
    deep_sleep_seconds INTEGER NOT NULL DEFAULT 0,
    rem_sleep_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS health_heart_rate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    resting_bpm INTEGER NOT NULL DEFAULT 0,
    avg_bpm INTEGER NOT NULL DEFAULT 0,
    max_bpm INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS health_workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    workout_type TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    calories_burned REAL NOT NULL DEFAULT 0,
    distance_meters REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_foods_date ON foods(date);
  CREATE INDEX IF NOT EXISTS idx_weight_log_date ON weight_log(date);
  CREATE INDEX IF NOT EXISTS idx_groceries_date ON groceries(date);
  CREATE INDEX IF NOT EXISTS idx_groceries_category ON groceries(category);
  CREATE INDEX IF NOT EXISTS idx_health_steps_date ON health_steps(date);
  CREATE INDEX IF NOT EXISTS idx_health_sleep_date ON health_sleep(date);
  CREATE INDEX IF NOT EXISTS idx_health_heart_rate_date ON health_heart_rate(date);
  CREATE INDEX IF NOT EXISTS idx_health_workouts_date ON health_workouts(date);
`);

app.use(express.json({ limit: '10mb' }));
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

function integerValue(value, fallback = 0) {
  return Math.round(numberValue(value, fallback));
}

function readConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function getExportData() {
  return {
    foods: db.prepare('SELECT id, description, calories, protein, carbs, fat, meal_type, date, source, created_at FROM foods ORDER BY date ASC, created_at ASC, id ASC').all(),
    weight_log: db.prepare('SELECT id, weight, date, source, created_at FROM weight_log ORDER BY date ASC, created_at ASC, id ASC').all(),
    groceries: db.prepare('SELECT id, name, quantity, category, price, date, source, created_at FROM groceries ORDER BY date ASC, created_at ASC, id ASC').all(),
    health_steps: db.prepare('SELECT id, date, step_count, created_at FROM health_steps ORDER BY date ASC, created_at ASC, id ASC').all(),
    health_sleep: db.prepare('SELECT id, date, sleep_seconds, deep_sleep_seconds, rem_sleep_seconds, created_at FROM health_sleep ORDER BY date ASC, created_at ASC, id ASC').all(),
    health_heart_rate: db.prepare('SELECT id, date, resting_bpm, avg_bpm, max_bpm, created_at FROM health_heart_rate ORDER BY date ASC, created_at ASC, id ASC').all(),
    health_workouts: db.prepare('SELECT id, date, workout_type, duration_seconds, calories_burned, distance_meters, created_at FROM health_workouts ORDER BY date ASC, created_at ASC, id ASC').all(),
    config: readConfig(),
    exported_at: nowISO(),
  };
}

function exportFilename(extension) {
  const stamp = nowISO().replace(/[:.]/g, '-');
  return `food-tracker-export-${stamp}.${extension}`;
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvSection(title, headers, rows) {
  return [
    title,
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(',')),
  ].join('\n');
}

function exportCsv(data) {
  const configRows = Object.entries(data.config)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));

  return [
    csvSection('FOOD', ['id', 'description', 'calories', 'protein', 'carbs', 'fat', 'meal_type', 'date', 'source', 'created_at'], data.foods),
    csvSection('WEIGHT', ['id', 'weight', 'date', 'source', 'created_at'], data.weight_log),
    csvSection('GROCERIES', ['id', 'name', 'quantity', 'category', 'price', 'date', 'source', 'created_at'], data.groceries),
    csvSection('HEALTH_STEPS', ['id', 'date', 'step_count', 'created_at'], data.health_steps),
    csvSection('HEALTH_SLEEP', ['id', 'date', 'sleep_seconds', 'deep_sleep_seconds', 'rem_sleep_seconds', 'created_at'], data.health_sleep),
    csvSection('HEALTH_HEART_RATE', ['id', 'date', 'resting_bpm', 'avg_bpm', 'max_bpm', 'created_at'], data.health_heart_rate),
    csvSection('HEALTH_WORKOUTS', ['id', 'date', 'workout_type', 'duration_seconds', 'calories_burned', 'distance_meters', 'created_at'], data.health_workouts),
    csvSection('CONFIG', ['key', 'value'], configRows),
  ].join('\n\n') + '\n';
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

function getRecentGroceries(days = 90) {
  return db.prepare(`
    SELECT *
    FROM groceries
    WHERE date >= date('now', ?)
    ORDER BY date DESC, created_at DESC, id DESC
  `).all(`-${days - 1} days`).map((row) => ({ ...row, price: Number(row.price || 0) }));
}

function getGrocerySuggestions() {
  const regularRows = db.prepare(`
    SELECT
      LOWER(TRIM(name)) AS normalized_name,
      name,
      COUNT(*) AS count,
      MAX(date) AS last_purchased
    FROM groceries
    WHERE date >= date('now', '-89 days')
    GROUP BY normalized_name
    HAVING COUNT(*) >= 3
    ORDER BY count DESC, last_purchased DESC, name ASC
  `).all();

  const runningLowRows = db.prepare(`
    SELECT
      LOWER(TRIM(name)) AS normalized_name,
      name,
      MAX(date) AS last_purchased
    FROM groceries
    GROUP BY normalized_name
    HAVING MAX(date) < date('now', '-29 days')
    ORDER BY last_purchased ASC, name ASC
    LIMIT 20
  `).all();

  const spendingRows = db.prepare(`
    SELECT category, COALESCE(SUM(price), 0) AS total
    FROM groceries
    WHERE date >= date('now', '-29 days')
    GROUP BY category
    ORDER BY total DESC, category ASC
  `).all();

  const recentCategoryRows = db.prepare(`
    SELECT category, MAX(date) AS last_purchased
    FROM groceries
    GROUP BY category
  `).all();
  const lastCategoryPurchase = new Map(recentCategoryRows.map((row) => [row.category, row.last_purchased]));

  return {
    regular_items: regularRows.map((row) => ({
      name: row.name,
      count: Number(row.count || 0),
      last_purchased: row.last_purchased,
    })),
    running_low: runningLowRows.map((row) => ({
      name: row.name,
      last_purchased: row.last_purchased,
      days_since: Math.max(0, Math.floor((Date.parse(`${todayISO()}T00:00:00Z`) - Date.parse(`${row.last_purchased}T00:00:00Z`)) / 86400000)),
    })),
    category_spending: Object.fromEntries(spendingRows.map((row) => [row.category, Number(row.total || 0)])),
    stale_categories: GROCERY_CATEGORIES.filter((category) => {
      const lastPurchased = lastCategoryPurchase.get(category);
      return !lastPurchased || lastPurchased < addDays(todayISO(), -29);
    }),
  };
}

function getRecentHealthRows(table, days = 30) {
  return db.prepare(`
    SELECT *
    FROM ${table}
    WHERE date >= date('now', ?)
    ORDER BY date ASC, created_at ASC, id ASC
  `).all(`-${days - 1} days`);
}

function average(rows, key) {
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length;
}

function getHealthSummary(steps, sleep, heartRate, workouts) {
  const sevenDaysAgo = addDays(todayISO(), -6);
  const steps7 = steps.filter((row) => row.date >= sevenDaysAgo);
  const sleep7 = sleep.filter((row) => row.date >= sevenDaysAgo);
  const heartRate7 = heartRate.filter((row) => row.date >= sevenDaysAgo && Number(row.resting_bpm || 0) > 0);

  return {
    avg_steps_7d: Math.round(average(steps7, 'step_count')),
    avg_steps_30d: Math.round(average(steps, 'step_count')),
    avg_sleep_7d: Math.round(average(sleep7, 'sleep_seconds')),
    avg_resting_hr_7d: Math.round(average(heartRate7, 'resting_bpm')),
    total_workouts_30d: workouts.length,
    total_calories_burned_30d: Number(workouts.reduce((sum, row) => sum + Number(row.calories_burned || 0), 0).toFixed(1)),
  };
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
  const healthSteps = getRecentHealthRows('health_steps').map((row) => ({ ...row, step_count: Number(row.step_count || 0) }));
  const healthSleep = getRecentHealthRows('health_sleep').map((row) => ({
    ...row,
    sleep_seconds: Number(row.sleep_seconds || 0),
    deep_sleep_seconds: Number(row.deep_sleep_seconds || 0),
    rem_sleep_seconds: Number(row.rem_sleep_seconds || 0),
  }));
  const healthHeartRate = getRecentHealthRows('health_heart_rate').map((row) => ({
    ...row,
    resting_bpm: Number(row.resting_bpm || 0),
    avg_bpm: Number(row.avg_bpm || 0),
    max_bpm: Number(row.max_bpm || 0),
  }));
  const healthWorkouts = getRecentHealthRows('health_workouts').map((row) => ({
    ...row,
    duration_seconds: Number(row.duration_seconds || 0),
    calories_burned: Number(row.calories_burned || 0),
    distance_meters: Number(row.distance_meters || 0),
  }));

  return {
    summary: getSummary(),
    today_foods: db.prepare('SELECT * FROM foods WHERE date = ? ORDER BY created_at ASC, id ASC').all(date),
    weight_history: db.prepare('SELECT * FROM weight_log ORDER BY date DESC LIMIT 90').all(),
    groceries: getRecentGroceries(90),
    grocery_suggestions: getGrocerySuggestions(),
    health_steps: healthSteps,
    health_sleep: healthSleep,
    health_heart_rate: healthHeartRate,
    health_workouts: healthWorkouts,
    health_summary: getHealthSummary(healthSteps, healthSleep, healthHeartRate, healthWorkouts),
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

function validateGrocery(body) {
  const name = String(body.name || '').trim();
  const quantity = String(body.quantity || '1').trim() || '1';
  const category = String(body.category || 'other').trim().toLowerCase();
  const price = numberValue(body.price);
  const date = body.date || todayISO();
  if (!name) return { error: 'name is required' };
  if (!GROCERY_CATEGORY_VALUES.has(category)) return { error: 'invalid category' };
  if (price < 0) return { error: 'price must be positive' };
  if (!isDate(date)) return { error: 'invalid date' };
  return { name, quantity, category, price, date };
}

function insertGrocery(body, source) {
  if (!SOURCES.has(source)) throw new Error('invalid source');
  const grocery = validateGrocery(body);
  if (grocery.error) return grocery;
  const result = db.prepare(`
    INSERT INTO groceries (name, quantity, category, price, date, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(grocery.name, grocery.quantity, grocery.category, grocery.price, grocery.date, source, nowISO());
  const row = db.prepare('SELECT * FROM groceries WHERE id = ?').get(result.lastInsertRowid);
  return { ...row, price: Number(row.price || 0) };
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

function validateHealthSteps(body) {
  const date = body.date || todayISO();
  const stepCount = integerValue(body.step_count, NaN);
  if (!isDate(date)) return { error: 'invalid date' };
  if (!Number.isFinite(stepCount) || stepCount < 0) return { error: 'step_count must be positive' };
  return { date, step_count: stepCount };
}

function validateHealthSleep(body) {
  const date = body.date || todayISO();
  const sleepSeconds = integerValue(body.sleep_seconds, NaN);
  const deepSleepSeconds = integerValue(body.deep_sleep_seconds);
  const remSleepSeconds = integerValue(body.rem_sleep_seconds);
  if (!isDate(date)) return { error: 'invalid date' };
  if (!Number.isFinite(sleepSeconds) || sleepSeconds < 0) return { error: 'sleep_seconds must be positive' };
  if (deepSleepSeconds < 0 || remSleepSeconds < 0) return { error: 'sleep stage values must be positive' };
  return {
    date,
    sleep_seconds: sleepSeconds,
    deep_sleep_seconds: deepSleepSeconds,
    rem_sleep_seconds: remSleepSeconds,
  };
}

function validateHealthHeartRate(body) {
  const date = body.date || todayISO();
  const restingBpm = integerValue(body.resting_bpm);
  const avgBpm = integerValue(body.avg_bpm);
  const maxBpm = integerValue(body.max_bpm);
  if (!isDate(date)) return { error: 'invalid date' };
  if (restingBpm < 0 || avgBpm < 0 || maxBpm < 0) return { error: 'heart rate values must be positive' };
  return { date, resting_bpm: restingBpm, avg_bpm: avgBpm, max_bpm: maxBpm };
}

function validateHealthWorkout(body) {
  const date = body.date || todayISO();
  const workoutType = String(body.workout_type || '').trim();
  const durationSeconds = integerValue(body.duration_seconds);
  const caloriesBurned = numberValue(body.calories_burned);
  const distanceMeters = numberValue(body.distance_meters);
  if (!isDate(date)) return { error: 'invalid date' };
  if (!workoutType) return { error: 'workout_type is required' };
  if (durationSeconds < 0 || caloriesBurned < 0 || distanceMeters < 0) return { error: 'workout values must be positive' };
  return {
    date,
    workout_type: workoutType,
    duration_seconds: durationSeconds,
    calories_burned: caloriesBurned,
    distance_meters: distanceMeters,
  };
}

function upsertHealthSteps(body) {
  const row = validateHealthSteps(body);
  if (row.error) return row;
  db.prepare(`
    INSERT INTO health_steps (date, step_count, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      step_count = excluded.step_count,
      created_at = excluded.created_at
  `).run(row.date, row.step_count, nowISO());
  return db.prepare('SELECT * FROM health_steps WHERE date = ?').get(row.date);
}

function upsertHealthSleep(body) {
  const row = validateHealthSleep(body);
  if (row.error) return row;
  db.prepare(`
    INSERT INTO health_sleep (date, sleep_seconds, deep_sleep_seconds, rem_sleep_seconds, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      sleep_seconds = excluded.sleep_seconds,
      deep_sleep_seconds = excluded.deep_sleep_seconds,
      rem_sleep_seconds = excluded.rem_sleep_seconds,
      created_at = excluded.created_at
  `).run(row.date, row.sleep_seconds, row.deep_sleep_seconds, row.rem_sleep_seconds, nowISO());
  return db.prepare('SELECT * FROM health_sleep WHERE date = ?').get(row.date);
}

function upsertHealthHeartRate(body) {
  const row = validateHealthHeartRate(body);
  if (row.error) return row;
  db.prepare(`
    INSERT INTO health_heart_rate (date, resting_bpm, avg_bpm, max_bpm, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      resting_bpm = excluded.resting_bpm,
      avg_bpm = excluded.avg_bpm,
      max_bpm = excluded.max_bpm,
      created_at = excluded.created_at
  `).run(row.date, row.resting_bpm, row.avg_bpm, row.max_bpm, nowISO());
  return db.prepare('SELECT * FROM health_heart_rate WHERE date = ?').get(row.date);
}

function insertHealthWorkout(body) {
  const row = validateHealthWorkout(body);
  if (row.error) return row;
  const result = db.prepare(`
    INSERT INTO health_workouts (date, workout_type, duration_seconds, calories_burned, distance_meters, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.date, row.workout_type, row.duration_seconds, row.calories_burned, row.distance_meters, nowISO());
  return db.prepare('SELECT * FROM health_workouts WHERE id = ?').get(result.lastInsertRowid);
}

function arrayBody(body, key) {
  const value = body[key] || [];
  return Array.isArray(value) ? value : null;
}

app.get('/api/summary', requireAgent, (req, res) => {
  res.json(getSummary());
});

app.post('/api/food', requireAgent, (req, res) => {
  const food = insertFood(req.body, 'agent');
  if (food.error) return res.status(400).json(food);
  res.status(201).json({ food, summary: getSummary() });
});

app.post('/api/groceries', requireAgent, (req, res) => {
  const grocery = insertGrocery(req.body, 'agent');
  if (grocery.error) return res.status(400).json(grocery);
  res.status(201).json({ grocery });
});

app.get('/api/groceries', requireAgent, (req, res) => {
  res.json({ groceries: db.prepare('SELECT * FROM groceries ORDER BY date DESC, created_at DESC, id DESC').all() });
});

app.post('/api/weight', requireAgent, (req, res) => {
  const weight = upsertWeight(req.body, 'agent');
  if (weight.error) return res.status(400).json(weight);
  res.status(201).json({ weight, summary: getSummary() });
});

app.post('/api/health-steps', requireAgent, (req, res) => {
  const steps = upsertHealthSteps(req.body);
  if (steps.error) return res.status(400).json(steps);
  res.status(201).json({ health_steps: steps });
});

app.post('/api/health-sleep', requireAgent, (req, res) => {
  const sleep = upsertHealthSleep(req.body);
  if (sleep.error) return res.status(400).json(sleep);
  res.status(201).json({ health_sleep: sleep });
});

app.post('/api/health-heart-rate', requireAgent, (req, res) => {
  const heartRate = upsertHealthHeartRate(req.body);
  if (heartRate.error) return res.status(400).json(heartRate);
  res.status(201).json({ health_heart_rate: heartRate });
});

app.post('/api/health-workout', requireAgent, (req, res) => {
  const workout = insertHealthWorkout(req.body);
  if (workout.error) return res.status(400).json(workout);
  res.status(201).json({ health_workout: workout });
});

app.post('/api/health-bulk', requireAgent, (req, res) => {
  const stepsRows = arrayBody(req.body, 'steps');
  const sleepRows = arrayBody(req.body, 'sleep');
  const heartRateRows = arrayBody(req.body, 'heart_rate');
  const workoutRows = arrayBody(req.body, 'workouts');
  if (!stepsRows || !sleepRows || !heartRateRows || !workoutRows) {
    return res.status(400).json({ error: 'steps, sleep, heart_rate, and workouts must be arrays when provided' });
  }

  const transaction = db.transaction(() => {
    const steps = stepsRows.map(upsertHealthSteps);
    const sleep = sleepRows.map(upsertHealthSleep);
    const heartRate = heartRateRows.map(upsertHealthHeartRate);
    const workouts = workoutRows.map(insertHealthWorkout);
    const invalid = [...steps, ...sleep, ...heartRate, ...workouts].find((row) => row.error);
    if (invalid) throw new Error(invalid.error);
    return { steps, sleep, heart_rate: heartRate, workouts };
  });

  try {
    const result = transaction();
    res.status(201).json({ imported: {
      steps: result.steps.length,
      sleep: result.sleep.length,
      heart_rate: result.heart_rate.length,
      workouts: result.workouts.length,
    } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/state', (req, res) => {
  res.json(getState());
});

app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename('json')}"`);
  res.json(getExportData());
});

app.get('/api/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename('csv')}"`);
  res.send(exportCsv(getExportData()));
});

app.post('/api/food-web', (req, res) => {
  const food = insertFood(req.body, 'me');
  if (food.error) return res.status(400).json(food);
  res.status(201).json({ food, state: getState() });
});

app.post('/api/groceries-web', (req, res) => {
  const grocery = insertGrocery(req.body, 'me');
  if (grocery.error) return res.status(400).json(grocery);
  res.status(201).json({ grocery, state: getState() });
});

app.delete('/api/food-web/:id', (req, res) => {
  const result = db.prepare('DELETE FROM foods WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'food not found' });
  res.json({ ok: true, state: getState() });
});

app.delete('/api/groceries-web/:id', (req, res) => {
  const result = db.prepare('DELETE FROM groceries WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'grocery not found' });
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
