const {
	cacheStorage,
	CacheStorageGroup,
	getManagedCacheStorage,
} = require('../cache');
const insure = require('./insure');
const select = require('./select');
const request = require('../request');

const format = (song) => {
	return {
		id: song.id,
		name: song.title,
		// album: {id: song.album_id, name: song.album_title},
		artists: { id: song.mid, name: song.author },
	};
};

const search = async (info) => {
	const url =
		'https://api.bilibili.com/audio/music-service-c/s?' +
		'search_type=music&page=1&pagesize=30&' +
		`keyword=${encodeURIComponent(info.keyword)}`;
	const response = await request('GET', url);
	const jsonBody = await response.json();
	const list = jsonBody.data.result.map(format);
	const matched = select(list, info);
	if (matched) return matched.id;
	return Promise.reject();
};

const track = async (id) => {
	const url =
		'https://www.bilibili.com/audio/music-service-c/web/url?rivilege=2&quality=2&' +
		'sid=' +
		id;

	try {
		const response = await request('GET', url);
		const jsonBody = await response.json();
		if (jsonBody.code === 0) {
			// bilibili music requires referer, connect do not support referer, so change to http
			return jsonBody.data.cdns[0].replace('https', 'http');
		} else {
			return Promise.reject();
		}
	} catch (e) {
		return insure().bilibili.track(id);
	}
};

const cs = getManagedCacheStorage('provider/bilibili');
const check = async (info) => {
	return track(await cs.cache(info, () => search(info)));
};

module.exports = { check, track };
