const Database = eval('require')('better-sqlite3');
const path = require('path');
const { logScope } = require('./logger');

const logger = logScope('database');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
let db;

try {
	db = new Database(dbPath);
	db.pragma('journal_mode = WAL');

	// Create table persistent_match
	db.exec(`
		CREATE TABLE IF NOT EXISTS persistent_match (
			netease_id TEXT PRIMARY KEY,
			platform TEXT NOT NULL,
			song_id TEXT NOT NULL,
			metadata TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	
	const count = db.prepare('SELECT count(*) as total FROM persistent_match').get().total;
	logger.info(`Database initialized at ${dbPath} (Total cached matches: ${count})`);
} catch (error) {
	logger.error(error, `Failed to initialize database at ${dbPath}`);
}

let stmtGet, stmtInsert;

if (db) {
	stmtGet = db.prepare('SELECT * FROM persistent_match WHERE netease_id = ?');
	stmtInsert = db.prepare(`
		INSERT OR REPLACE INTO persistent_match (netease_id, platform, song_id, metadata, updated_at)
		VALUES (?, ?, ?, ?, ?)
	`);
}

/**
 * @param {string|number} netease_id
 * @returns {object|null}
 */
const getPersistentMatch = (netease_id) => {
	if (!db) return null;
	try {
		const row = stmtGet.get(String(netease_id));
		if (row) {
			row.metadata = JSON.parse(row.metadata);
			return row;
		}
	} catch (e) {
		logger.error(e, 'Failed to get match from database');
	}
	return null;
};

/**
 * @param {string|number} netease_id
 * @param {string} platform
 * @param {string} song_id
 * @param {object} meta
 */
const savePersistentMatch = (netease_id, platform, song_id, meta) => {
	if (!db) return;
	try {
		const clean_song_id = String(song_id || '');

		// Strict assertions to prevent pollution
		if (!clean_song_id || clean_song_id === '[object Object]') {
			throw new Error(`Invalid song_id type or format: ${clean_song_id}`);
		}
		if (clean_song_id.includes('http://') || clean_song_id.includes('https://')) {
			throw new Error(`Invalid song_id format, contains URL: ${clean_song_id}`);
		}
		
		stmtInsert.run(
			String(netease_id),
			platform,
			clean_song_id,
			JSON.stringify(meta),
			Date.now()
		);
		logger.debug({ id: netease_id, platform, song_id: clean_song_id }, 'Successfully persisted match to database');
	} catch (e) {
		logger.error(e, 'Failed to save match to database');
	}
};

module.exports = {
	db,
	getMatch: getPersistentMatch,       // Kept for backward compatibility if needed temporarily
	saveMatch: savePersistentMatch,     // Kept for backward compatibility if needed temporarily
	getPersistentMatch,
	savePersistentMatch
};