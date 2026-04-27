const fs = require('fs');
const path = require('path');
const { logScope } = require('./logger');

const logger = logScope('database');

// 数据库文件路径，改为 .json 后缀
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.json');

// 内存缓存对象，用于 O(1) 复杂度的极速查询
let cache = {};

// 启动时读取本地 JSON 文件加载到内存
try {
	if (fs.existsSync(dbPath)) {
		const data = fs.readFileSync(dbPath, 'utf8');
		cache = JSON.parse(data);
		logger.info(`JSON Database loaded from ${dbPath} (Total cached matches: ${Object.keys(cache).length})`);
	} else {
		logger.info(`JSON Database created at ${dbPath}`);
	}
} catch (error) {
	logger.error(error, `Failed to load JSON database from ${dbPath}`);
	cache = {};
}

// 防抖写入函数：避免短时间内频繁写入磁盘，提升性能并保护手机闪存
let writeTimeout = null;
const persistData = () => {
	if (writeTimeout) clearTimeout(writeTimeout);
	writeTimeout = setTimeout(() => {
		try {
			// 将内存中的对象序列化为 JSON 字符串并异步写入文件
			fs.writeFile(dbPath, JSON.stringify(cache), 'utf8', (err) => {
				if (err) logger.error(err, 'Failed to save JSON database to disk');
			});
		} catch (e) {
			logger.error(e, 'Failed to serialize JSON database');
		}
	}, 2000); // 在最后一次匹配成功的 2 秒后执行写入
};

const getPersistentMatch = (netease_id) => {
	try {
		// 直接从内存对象中按 key 取值，时间复杂度为 O(1)，速度极快
		const match = cache[netease_id];
		if (match) {
			return {
				platform: match.platform,
				song_id: match.song_id,
				metadata: match.metadata || {}
			};
		}
	} catch (e) {
		logger.error(e, 'Failed to get match from JSON database');
	}
	return null;
};

const savePersistentMatch = (netease_id, platform, song_id, metadata) => {
	try {
		const clean_song_id = String(song_id);
		// 更新内存对象
		cache[netease_id] = {
			platform,
			song_id: clean_song_id,
			metadata: metadata || {},
			updated_at: Date.now()
		};
		
		logger.debug({ id: netease_id, platform, song_id: clean_song_id }, 'Successfully persisted match to JSON database');
		
		// 触发防抖写入磁盘
		persistData();
	} catch (e) {
		logger.error(e, 'Failed to save match to JSON database');
	}
};

module.exports = {
	getPersistentMatch,
	savePersistentMatch,
};
