const find = require('./find');
const request = require('../request');
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
	(process.env.SEARCH_ALBUM || 'true').toLowerCase() === 'true';

const isHttpResponseOk = (code) => code >= 200 && code <= 299;

const headerReferer = new Map([
	['bilivideo.com', 'https://www.bilibili.com/'],
	['upos-hz-mirrorakam.akamaized.net', 'https://www.bilibili.com/'],
]);

async function getAudioFromSource(source, info) {
	logger.debug({ source, info }, 'Getting the audio...');
	const audioData = await providers[source].check(info);
	if (!audioData) throw new SongNotAvailable(source);

	const urlToCheck = (typeof audioData === 'object' && audioData.url) ? audioData.url : audioData;
	const song = await check(urlToCheck);

	logger.debug(song, 'The matched song is:');
	if (!song || typeof song.url !== 'string')
		throw new IncompleteAudioData(
			'song is undefined, or song.url is not a string.'
		);

	if (song.br === 999000 && song.size > 0 && info.duration > 0) {
		const realBitrate = Math.round((song.size * 8) / (info.duration / 1000));
		logger.debug(
			`Correcting FLAC bitrate for song ${info.id}. From placeholder 999000 to calculated ${realBitrate}.`
		);
		song.br = realBitrate;
	}

	logger.debug({ source, info }, 'The audio matched!');
	return {
		...song,
		...(typeof audioData === 'object' && audioData),
		source,
	};
}

async function match(id, source, data) {
	const candidate = (source || global.source || defaultSrc).filter(
		(name) => name in providers
	);

	const audioInfo = await find(id, data);
	let audioData = null;

	const QUALITY_RANKING = {
		'jymaster': 6, 'master': 5, 'hires': 4, 'sky': 3,
		'lossless': 2, 'flac': 2, '320k': 1, '128k': 0,
	};
	const getQualityScore = (song) => {
		if (!song || !song.qualityLabel) return -1;
		return QUALITY_RANKING[song.qualityLabel] || -1;
	};

	if (process.env.SELECT_MAX_BR) {
		let audioDataArr = await Promise.allSettled(
			candidate.map(async (source) =>
				getAudioFromSource(source, audioInfo).catch((e) => {
					if (e) {
						if (e instanceof RequestCancelled) logger.debug(e);
						else logger.error(e.message || e); // 修正：安全地记录错误
					}
					throw e;
				})
			)
		);

		audioDataArr = audioDataArr.filter(
			(result) => result.status === 'fulfilled'
		);

		if (audioDataArr.length === 0) {
			throw new SongNotAvailable('any source');
		}

		audioDataArr = audioDataArr.map((result) => result.value);
		audioData = audioDataArr.reduce((best, current) =>
			getQualityScore(current) >= getQualityScore(best) ? current : best
		);
	} else if (FOLLOW_SOURCE_ORDER) {
		for (let i = 0; i < candidate.length; i++) {
			const source = candidate[i];
			try {
				audioData = await getAudioFromSource(source, audioInfo);
				break;
			} catch (e) {
				if (e) {
					if (e instanceof RequestCancelled) logger.debug(e);
					else logger.error(e.message || e);
				}
			}
		}

		if (!audioData) {
			throw new Error('No audioData!');
		}
	} else {
		audioData = await Promise.any(
			candidate.map(async (source) =>
				getAudioFromSource(source, audioInfo).catch((e) => {
					if (e) {
						if (e instanceof RequestCancelled) logger.debug(e);
						else logger.error(e.message || e);
					}
					throw e;
				})
			)
		);
	}

	const { id: audioId, name } = audioInfo;
	const { url } = audioData;
	logger.debug({ audioInfo, audioData }, 'The data to replace:');
	logger.debug({ audioId, songName: name, url }, `Replaced: [${audioId}] ${name}`);
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

	// ... (此处省略一些补充br的逻辑) ...
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

		// --- 核心修正：注释掉过于严格的检查 ---
		/* if (headers['content-length'] !== '8192') {
			return Promise.reject();
		} */
	}

	return song;
}

function decode(buffer) {
	const map = {
		3: {
			3: [
				'free',
				32,
				64,
				96,
				128,
				160,
				192,
				224,
				256,
				288,
				320,
				352,
				384,
				416,
				448,
				'bad',
			],
			2: [
				'free',
				32,
				48,
				56,
				64,
				80,
				96,
				112,
				128,
				160,
				192,
				224,
				256,
				320,
				384,
				'bad',
			],
			1: [
				'free',
				32,
				40,
				48,
				56,
				64,
				80,
				96,
				112,
				128,
				160,
				192,
				224,
				256,
				320,
				'bad',
			],
		},
		2: {
			3: [
				'free',
				32,
				48,
				56,
				64,
				80,
				96,
				112,
				128,
				144,
				160,
				176,
				192,
				224,
				256,
				'bad',
			],
			2: [
				'free',
				8,
				16,
				24,
				32,
				40,
				48,
				56,
				64,
				80,
				96,
				112,
				128,
				144,
				160,
				'bad',
			],
		},
	};
	map[2][1] = map[2][2];
	map[0] = map[2];

	let pointer = 0;
	if (buffer.slice(0, 4).toString() === 'fLaC') return 999;
	if (buffer.slice(0, 3).toString() === 'ID3') {
		pointer = 6;
		const size = buffer
			.slice(pointer, pointer + 4)
			.reduce(
				(summation, value, index) =>
					(summation + (value & 0x7f)) << (7 * (3 - index)),
				0
			);
		pointer = 10 + size;
	}
	const header = buffer.slice(pointer, pointer + 4);

	// https://www.allegro.cc/forums/thread/591512/674023
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
