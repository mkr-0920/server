const Database = require('better-sqlite3');
const path = require('path');
const { logScope } = require('./logger');

const logger = logScope('database');

// Place data.db in the project root
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
let db;

try {
	db = new Database(dbPath);
	db.pragma('journal_mode = WAL'); // Better concurrency

	// Initialize the table if it doesn't exist
	db.exec(`
		CREATE TABLE IF NOT EXISTS match_cache (
			netease_id TEXT PRIMARY KEY,
			source TEXT NOT NULL,
			matched_id TEXT,
			meta_json TEXT NOT NULL,
			utime INTEGER NOT NULL
		)
	`);
	
	const count = db.prepare('SELECT count(*) as total FROM match_cache').get().total;
	logger.info(`Database initialized at ${dbPath} (Total cached matches: ${count})`);
} catch (error) {
	logger.error(error, `Failed to initialize database at ${dbPath}`);
}

let stmtGet, stmtInsert;

if (db) {
	stmtGet = db.prepare('SELECT * FROM match_cache WHERE netease_id = ?');
	stmtInsert = db.prepare(`
		INSERT OR REPLACE INTO match_cache (netease_id, source, matched_id, meta_json, utime)
		VALUES (?, ?, ?, ?, ?)
	`);
}

/**
 * Get a cached match for a Netease song ID
 * @param {string|number} netease_id
 * @returns {object|null}
 */
const getMatch = (netease_id) => {
	if (!db) return null;
	try {
		const row = stmtGet.get(String(netease_id));
		if (row) {
			row.meta = JSON.parse(row.meta_json);
			return row;
		}
	} catch (e) {
		logger.error(e, 'Failed to get match from database');
	}
	return null;
};

/**
 * Save a successful match to the database
 * @param {string|number} netease_id
 * @param {string} source
 * @param {object} meta - The song object resolved from the provider's check/search
 */
const saveMatch = (netease_id, source, meta) => {
	if (!db) return;
	try {
		// Robustly extract the most specific native ID for storage
		let matched_id = '';
		// Prioritize the native_id property we added in match.js
		const idObj = meta.native_id || meta.id || meta;
		
		if (typeof idObj === 'object') {
			matched_id = String(idObj.song || idObj.id || '');
		} else {
			matched_id = String(idObj);
		}

		// CRITICAL CHECK: Ensure we didn't accidentally catch a URL as the ID
		if (!matched_id || matched_id === '[object Object]' || matched_id.includes('http')) {
			return; 
		}
		
		stmtInsert.run(
			String(netease_id),
			source,
			matched_id,
			JSON.stringify(meta),
			Date.now()
		);
		logger.debug({ id: netease_id, source }, 'Successfully persisted match to database');
	} catch (e) {
		logger.error(e, 'Failed to save match to database');
	}
};

module.exports = {
	db,
	getMatch,
	saveMatch
};
