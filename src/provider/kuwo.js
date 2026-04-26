const insure = require('./insure');
const select = require('./select');
const crypto = require('../crypto');
const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

const format = (song) => ({
	id: song.MUSICRID.split('_').pop(),
	name: song.SONGNAME,
	// duration: song.songTimeMinutes.split(':').reduce((minute, second) => minute * 60 + parseFloat(second), 0) * 1000,
	duration: song.DURATION * 1000,
	album: { id: song.ALBUMID, name: song.ALBUM },
	artists: song.ARTIST.split('&').map((name, index) => ({
		id: index ? null : song.ARTISTID,
		name,
	})),
});

const search = async (info) => {
	const keyword = encodeURIComponent(info.keyword.replace(' - ', ' '));
	const url =
		'http://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8' +
		'&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=' +
		keyword;

	const response = await request('GET', url);
	const jsonBody = await response.json();
	if (
		!jsonBody ||
		jsonBody.content.length < 2 ||
		!jsonBody.content[1].musicpage ||
		jsonBody.content[1].musicpage.abslist.length < 1
	)
		return Promise.reject();
	const list = jsonBody.content[1].musicpage.abslist.map(format);
	const matched = select(list, info);
	if (matched) return matched.id;
	return Promise.reject();
};

const track = async (id) => {
	const url = crypto.kuwoapi
		? 'http://mobi.kuwo.cn/mobi.s?f=kuwo&q=' +
			crypto.kuwoapi.encryptQuery(
				'user=0&corp=kuwo&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&type=convert_url2&sig=0&format=' +
					['flac', 'mp3']
						.slice(select.ENABLE_FLAC ? 0 : 1)
						.join('|') +
					'&rid=' +
					id
			)
		: 'http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_' +
			id; // flac refuse

	try {
		const response = await request('GET', url, { 'user-agent': 'okhttp/3.10.0' });
		const body = await response.body();
		const matchUrl = (body.match(/http[^\s$"]+/) || [])[0];
		if (matchUrl) return matchUrl;
		return Promise.reject();
	} catch (e) {
		return insure().kuwo.track(id);
	}
};

const cs = getManagedCacheStorage('provider/kuwo');
const check = async (info) => {
	return track(await cs.cache(info, () => search(info)));
};

module.exports = { check, track };
