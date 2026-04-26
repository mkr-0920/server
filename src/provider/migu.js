const insure = require('./insure');
const select = require('./select');
const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

const headers = {
	origin: 'http://music.migu.cn/',
	referer: 'http://m.music.migu.cn/v3/',
	// cookie: 'migu_music_sid=' + (process.env.MIGU_COOKIE || null),
	aversionid: process.env.MIGU_COOKIE || null,
	channel: '0146921',
};

const format = (song) => {
	const singerId = song.singerId.split(/\s*,\s*/);
	const singerName = song.singerName.split(/\s*,\s*/);
	return {
		// id: song.copyrightId,
		id: song.id,
		name: song.title,
		album: { id: song.albumId, name: song.albumName },
		artists: singerId.map((id, index) => ({ id, name: singerName[index] })),
	};
};

const search = async (info) => {
	const url =
		'https://m.music.migu.cn/migu/remoting/scr_search_tag?' +
		'keyword=' +
		encodeURIComponent(info.keyword) +
		'&type=2&rows=20&pgc=1';

	const response = await request('GET', url, headers);
	const jsonBody = await response.json();
	const list = ((jsonBody || {}).musics || []).map(format);
	const matched = select(list, info);
	if (matched) return matched.id;
	return Promise.reject();
};

const single = async (id, format) => {
	// const url =
	//	'https://music.migu.cn/v3/api/music/audioPlayer/getPlayInfo?' +
	//	'dataType=2&' + crypto.miguapi.encryptBody({copyrightId: id.toString(), type: format})

	const url =
		'https://app.c.nf.migu.cn/MIGUM2.0/strategy/listen-url/v2.4?' +
		'netType=01&resourceType=2&songId=' +
		id.toString() +
		'&toneFlag=' +
		format;

	const response = await request('GET', url, headers);
	const jsonBody = await response.json();
	const { audioFormatType } = jsonBody.data;
	if (audioFormatType !== format) return Promise.reject();
	if (url) return jsonBody.data.url;
	return Promise.reject();
};

const track = async (id) => {
	try {
		const formats = ['ZQ24', 'SQ', 'HQ', 'PQ'].slice(select.ENABLE_FLAC ? 0 : 2);
		const promises = formats.map(async (format) => {
			try {
				return await single(id, format);
			} catch (e) {
				return null;
			}
		});
		const result = await Promise.all(promises);
		const url = result.find((u) => u);
		if (url) return url;
		return Promise.reject();
	} catch (e) {
		return insure().migu.track(id);
	}
};

const cs = getManagedCacheStorage('provider/migu');
const check = async (info) => {
	return track(await cs.cache(info, () => search(info)));
};

module.exports = { check, track };
