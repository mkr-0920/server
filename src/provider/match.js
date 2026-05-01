const find = require('./find');
const request = require('../request');
const { getPersistentMatch, savePersistentMatch } = require('../database');
const {
	PROVIDERS: providers,
	DEFAULT_SOURCE: defaultSrc,
} = require('../consts');
const { isHostWrapper } = require('../utilities');
const SongNotAvailable = require('../exceptions/SongNotAvailable');
const RequestFailed = require('../exceptions/RequestFailed');
const IncompleteAudioData = require('../exceptions/IncompleteAudioData');
const { logScope } = require('../logger');
const RequestCancelled = require('../exceptions/RequestCancelled');

const logger = logScope('provider/match');

const FOLLOW_SOURCE_ORDER =
	(process.env.FOLLOW_SOURCE_ORDER || 'true').toLowerCase() === 'true';

const isHttpResponseOk = (code) => code >= 200 && code <= 299;

const headerReferer = new Map([
	['bilivideo.com', 'https://www.bilibili.com/'],
	['upos-hz-mirrorakam.akamaized.net', 'https://www.bilibili.com/'],
]);

/**
 * @param {string} source
 * @param {object} info
 * @returns {Promise<object>}
 */
async function getAudioFromSource(source, info) {
	logger.debug({ source, info }, 'Getting the audio...');
	const rawAudioData = await providers[source].check(info);
	if (!rawAudioData) throw new SongNotAvailable(source);

	// Updated providers return {url, id}. Legacy ones return string url.
	const isObjectResult = (typeof rawAudioData === 'object' && rawAudioData.url);
	const urlToCheck = isObjectResult ? rawAudioData.url : rawAudioData;
	const song = await check(urlToCheck);

	logger.debug(song, 'The matched song is:');
	if (!song || typeof song.url !== 'string')
		throw new IncompleteAudioData('song is undefined, or song.url is not a string.');

	if (song.br === 999000 && song.size > 0 && info.duration > 0) {
		const realBitrate = Math.round((song.size * 8) / (info.duration / 1000));
		logger.debug(
			`Correcting FLAC bitrate for song ${info.id}. From placeholder 999000 to calculated ${realBitrate}.`
		);
		song.br = realBitrate;
	}

	logger.debug({ source, info }, 'The audio matched!');
	
	const result = {
		...song,
		...(isObjectResult && rawAudioData),
		source
	};
	
	// Strictly define the platform_id if available
	if (isObjectResult && rawAudioData.id) {
		result.platform_id = String(rawAudioData.id);
	}
	
	return result;
}

/**
 * @param {string} id
 * @param {string[]} [source]
 * @param {object} [data]
 * @returns {Promise<object>}
 */
async function match(id, source, data) {
	const candidate = (source || global.source || defaultSrc).filter(
		(name) => name in providers
	);

	let audioData = null;

	// Level 2: Persistent Cache Check (Generic)
	const cachedMatch = getPersistentMatch(id);
	if (cachedMatch && providers[cachedMatch.platform] && typeof providers[cachedMatch.platform].track === 'function') {
		const platform = cachedMatch.platform;
		const song_id = cachedMatch.song_id;
		
		logger.info(`[CACHE HIT] Found persistent match for song ${id} in provider [${platform}]`);
		
		try {
			let useCachedUrl = false;
			// 乐观锁：假设存下来的 URL 仍然有效，直接 check
			if (cachedMatch.metadata && cachedMatch.metadata.url) {
				try {
					logger.debug(`[OPTIMISTIC CACHE] Testing cached URL for song ${id}...`);
					audioData = await check(cachedMatch.metadata.url);
					
					// 试探成功后，检查体积是否被掉包 (误差>20%)
					if (cachedMatch.metadata.size && audioData.size) {
						const diffRatio = Math.abs(audioData.size - cachedMatch.metadata.size) / cachedMatch.metadata.size;
						if (diffRatio > 0.2) {
							logger.warn(`[CACHE INVALID] Size mismatch for ${id}. Expected ~${cachedMatch.metadata.size}, got ${audioData.size}. Re-searching...`);
							throw new Error('Size mismatch, potential hot-swap detected');
						}
					}
					
					audioData.source = platform;
					audioData.platform_id = song_id;
					useCachedUrl = true;
					logger.info(`[OPTIMISTIC CACHE SUCCESS] Cached URL is still valid!`);
				} catch (err) {
					logger.warn(`[OPTIMISTIC CACHE FAILED] Cached URL expired or invalid (Error: ${err.message}). Fetching a new URL...`);
				}
			}

			if (!useCachedUrl) {
				// 回源：重新请求 track 获取新鲜 URL
				const url = await providers[platform].track(song_id);
				if (url) {
					const urlToCheck = (typeof url === 'object' && url.url) ? url.url : url;
					audioData = await check(urlToCheck);

					if (cachedMatch.metadata && cachedMatch.metadata.size && audioData.size) {
						const diffRatio = Math.abs(audioData.size - cachedMatch.metadata.size) / cachedMatch.metadata.size;
						if (diffRatio > 0.2) {
							logger.warn(`[CACHE INVALID] Size mismatch for ${id}. Expected ~${cachedMatch.metadata.size}, got ${audioData.size}. Re-searching...`);
							throw new Error('Size mismatch, potential hot-swap detected');
						}
					}

					audioData.source = platform;
					audioData.platform_id = song_id;
					
					// 覆盖更新：将带有新 URL 的完整数据重新写入 JSON
					savePersistentMatch(id, audioData.source, audioData.platform_id, audioData);
				} else {
					throw new Error('Track returned empty URL');
				}
			}
			
			if (audioData) {
				logger.info(
					{
						'歌曲ID': id,
						'音源平台': audioData.source,
						'码率 (bps)': audioData.br,
						'歌曲链接': audioData.url
					},
					`[MATCH SUCCESS] (从持久化缓存) 最终选择的音源:`
				);
				return audioData;
			}
		} catch (e) {
			logger.warn(`[CACHE INVALID] Persistent match for ${id} failed entirely. Re-searching full platforms...`);
		}
	}

	const audioInfo = await find(id, data);

	if (FOLLOW_SOURCE_ORDER) {
		logger.debug('Using "Source Order" strategy.');
		for (let i = 0; i < candidate.length; i++) {
			const providerSource = candidate[i];
			try {
				audioData = await getAudioFromSource(providerSource, audioInfo);
				break;
			} catch (e) {
				if (e) {
					if (e instanceof RequestCancelled) logger.debug(e);
					else logger.error(e.message || e);
				}
			}
		}

		if (!audioData) {
			throw new Error('没有找到可用的音源数据!');
		}

	} else {
		logger.debug('Using "Max Bitrate" (quality first) strategy.');
		let audioDataArr = await Promise.allSettled(
			candidate.map(async (providerSource) =>
				getAudioFromSource(providerSource, audioInfo).catch((e) => {
					if (e) {
						if (e instanceof RequestCancelled) logger.debug(e);
						else logger.error(e.message || e);
					}
					throw e;
				})
			)
		);

		audioDataArr = audioDataArr.filter(
			(result) => result.status === 'fulfilled'
		);

		if (audioDataArr.length === 0) {
			throw new SongNotAvailable('任何可用音源');
		}

		audioDataArr = audioDataArr.map((result) => result.value);

		audioData = audioDataArr.reduce((best, current) =>
			(current.br || 0) >= (best.br || 0) ? current : best
		);
	}

	// Only save if the provider gave us a clean string platform_id and it's not pyncmd
	if (audioData && audioData.source !== 'pyncmd' && audioData.platform_id) {
		// 全量落库（恢复 URL 存储）
		savePersistentMatch(id, audioData.source, audioData.platform_id, audioData);
	}

	logger.info(
		{
			'歌曲ID': audioInfo.id,
			'歌名': audioInfo.name,
			'音源平台': audioData.source,
			'码率 (bps)': audioData.br,
			'歌曲链接': audioData.url
		},
		`[MATCH SUCCESS] 最终选择的音源:`
	);
	return audioData;
}

async function check(url) {
	const isHost = isHostWrapper(url);
	const song = { size: 0, br: null, url: null, md5: null };
	const header = {
		range: 'bytes=0-8191',
		'accept-encoding': 'identity',
	};

	headerReferer.forEach((refererValue, urlPattern) => {
		if (isHost(urlPattern)) header.referer = refererValue;
	});

	const response = await request('GET', url, header);
	const { headers } = response;

	if (!isHttpResponseOk(response.statusCode))
		throw new RequestFailed(url, response.statusCode);

	song.url = response.url.href;

	const data = await response.body(true);

	try {
		const bitrate = decode(data);
		song.br = bitrate && !isNaN(bitrate) ? bitrate * 1000 : null;
	} catch (e) {
		logger.debug(e, 'Failed to decode and extract the bitrate');
	}

	if (!song.br) {
		if (isHost('qq.com') && song.url.includes('.m4a')) {
			song.br = 96000;
		}
		if (isHost('bilivideo.com') && song.url.includes('.m4a')) {
			const result = song.url.match(/-(\d+)k\.m4a/);
			let bitrate = parseInt(result);
			if (isNaN(bitrate)) bitrate = 192000;
			else if (bitrate < 96 || bitrate > 999) bitrate = 192000;
			else bitrate *= 1000;
			song.br = bitrate;
		}
		if (isHost('googlevideo.com')) {
			song.br = 128000;
		}
	}

	if (headers) {
		if (isHost('126.net'))
			song.md5 = song.url.split('/').slice(-1)[0].replace(/\..*/g, '');
		if (isHost('qq.com')) song.md5 = headers['server-md5'];

		song.size =
			parseInt(
				(headers['content-range'] || '').split('/').pop() ||
					headers['content-length']
			) || 0;
	}

	return song;
}

function decode(buffer) {
	const map = {
		3: {
			3: ['free', 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 'bad'],
			2: ['free', 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 'bad'],
			1: ['free', 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 'bad'],
		},
		2: {
			3: ['free', 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 'bad'],
			2: ['free', 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 'bad'],
		},
	};
	map[2][1] = map[2][2];
	map[0] = map[2];

	let pointer = 0;
	if (buffer.slice(0, 4).toString() === 'fLaC') return 999;
	if (buffer.slice(0, 3).toString() === 'ID3') {
		pointer = 6;
		const size = buffer.slice(pointer, pointer + 4).reduce(
			(summation, value, index) => (summation + (value & 0x7f)) << (7 * (3 - index)), 0
		);
		pointer = 10 + size;
	}
	const header = buffer.slice(pointer, pointer + 4);

	if (
		header.length === 4 &&
		header[0] === 0xff &&
		((header[1] >> 5) & 0x7) === 0x7 &&
		((header[1] >> 1) & 0x3) !== 0 &&
		((header[2] >> 4) & 0xf) !== 0xf &&
		((header[2] >> 2) & 0x3) !== 0x3
	) {
		const version = (header[1] >> 3) & 0x3;
		const layer = (header[1] >> 1) & 0x3;
		const bitrate = header[2] >> 4;
		return map[version][layer][bitrate];
	}
}

module.exports = match;