const insure = require('./insure');
const select = require('./select');
const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

let COOKIE = process.env.NEW_QQ_COOKIE || process.env.QQ_COOKIE;
const headers = {
	origin: 'http://y.qq.com/',
	referer: 'http://y.qq.com/',
	cookie: COOKIE || null,
};

const refresh = async () => {
	const refresh_token = (COOKIE.match(/qqrefresh_token=([^;]*)/) || [])[1] || '';
	const musickey = (COOKIE.match(/qqmusic_key=([^;]*)/) || [])[1] || '';
	const musicid = parseInt((COOKIE.match(/uin=(\d+)/) || [])[1] || 0, 10);

	const body = {
		req: {
			module: 'music.login.LoginServer',
			method: 'Login',
			param: {
				refresh_token: refresh_token,
				musickey: musickey,
				musicid: musicid,
			},
		},
	};
	const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

	try {
		const response = await request(
			'POST',
			url,
			{
				Cookie: COOKIE,
				'Content-Type': 'application/json',
			},
			JSON.stringify(body)
		);
		const jsonBody = await response.json();
		const data = jsonBody.req?.data || {};
		const newMusickey = data.musickey;
		const newMusickeyCreateTime = data.musickeyCreateTime;
		if (!newMusickey || !newMusickeyCreateTime) return;

		let newCookie = COOKIE;
		newCookie = newCookie
			.replace(/(qqmusic_key=)[^;]*/, `$1${newMusickey}`)
			.replace(/(qm_keyst=)[^;]*/, `$1${newMusickey}`)
			.replace(/(psrf_musickey_createtime=)[^;]*/, `$1${newMusickeyCreateTime}`);
		process.env.NEW_QQ_COOKIE = newCookie;
		headers.cookie = newCookie;
		COOKIE = newCookie;
	} catch (e) {
		// Handle or ignore refresh error
	}
};

const format = (song) => ({
	// Only store the pure string mid to fulfill the strict contract
	id: String(song.mid),
	name: song.name,
	duration: song.interval * 1000,
	album: { id: song.album.mid, name: song.album.name },
	artists: song.singer.map(({ mid, name }) => ({ id: mid, name })),
});

const search = async (info) => {
	const url =
		'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' +
		encodeURIComponent(
			JSON.stringify({
				search: {
					method: 'DoSearchForQQMusicDesktop',
					module: 'music.search.SearchCgiService',
					param: {
						num_per_page: 5,
						page_num: 1,
						query: info.keyword,
						search_type: 0,
					},
				},
			})
		);

	try {
		const response = await request('GET', url, headers);
		const jsonBody = await response.json();
		const result = jsonBody.search.data.body.song.list.map(format);
		const matched = select(result, info);
		if (matched) return matched.id; // Returns string mid
		return Promise.reject();
	} catch (e) {
		return Promise.reject();
	}
};

const track = async (mid) => {
	if (!mid || typeof mid !== 'string') return Promise.reject();

	try {
		const baseUrl = process.env.LX_API_URL || '';
		const apiUrl = `${baseUrl}/url?source=tx&songId=${mid}&quality=flac`;

		const apiHeaders = {};
		const apiKey = process.env.LX_API_KEY || '';
		if (apiKey) {
			apiHeaders['X-Request-Key'] = apiKey;
		}

		const response = await request('GET', apiUrl, apiHeaders);
		const jsonBody = await response.json();

		if (jsonBody.code === 200 && jsonBody.url) {
			return jsonBody.url;
		}

		return Promise.reject();
	} catch (e) {
		// We pass string mid back to insure if it falls back.
		// Note: ensure insure logic accepts string if it's called.
		return insure().qq.track(mid);
	}
};

const cs = getManagedCacheStorage('provider/qq');

const check = async (info) => {
	const now = Math.floor(Date.now() / 1000);
	const musickey_createtime =
		((COOKIE || '').match(/musickey_createtime=(\d+)/) || [])[1] || '';
	const createTime = parseInt(musickey_createtime, 10) + 259200;
	if (musickey_createtime && createTime - now < 600) {
		await refresh();
	}

	try {
		const mid = await cs.cache(info, () => search(info));
		const url = await track(mid);
		return { url, id: mid };
	} catch (e) {
		return Promise.reject();
	}
};

module.exports = { check, track };
