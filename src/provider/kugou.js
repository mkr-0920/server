const insure = require('./insure');
const select = require('./select');
const crypto = require('../crypto');
const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

const format = (song) => {
	return {
		// id: song.FileHash,
		// name: song.SongName,
		// duration: song.Duration * 1000,
		// album: {id: song.AlbumID, name: song.AlbumName},
		// artists: song.SingerId.map((id, index) => ({id, name: SingerName[index]}))
		id: song['hash'],
		id_hq: song['320hash'],
		id_sq: song['sqhash'],
		name: song['songname'],
		duration: song['duration'] * 1000,
		album: { id: song['album_id'], name: song['album_name'] },
	};
};

const search = async (info) => {
	const url =
		// 'http://songsearch.kugou.com/song_search_v2?' +
		'http://mobilecdn.kugou.com/api/v3/search/song?' +
		'keyword=' +
		encodeURIComponent(info.keyword) +
		'&page=1&pagesize=10';

	try {
		const response = await request('GET', url);
		const jsonBody = await response.json();
		// const list = jsonBody.data.lists.map(format)
		const list = jsonBody.data.info.map(format);
		const matched = select(list, info);
		if (matched) return matched;
		return Promise.reject();
	} catch (e) {
		return insure().kugou.search(info);
	}
};

const single = async (song, format) => {
	const getHashId = () => {
		switch (format) {
			case 'hash':
				return song.id;
			case 'hqhash':
				return song.id_hq;
			case 'sqhash':
				return song.id_sq;
			default:
				break;
		}
		return '';
	};

	const url =
		'http://trackercdn.kugou.com/i/v2/?' +
		'key=' +
		crypto.md5.digest(`${getHashId()}kgcloudv2`) +
		'&hash=' +
		getHashId() +
		'&' +
		'appid=1005&pid=2&cmd=25&behavior=play&album_id=' +
		song.album.id;
		
	const response = await request('GET', url);
	const jsonBody = await response.json();
	if (jsonBody.url[0]) return jsonBody.url[0];
	return Promise.reject();
};

const track = async (song) => {
	try {
		const formats = ['sqhash', 'hqhash', 'hash'].slice(select.ENABLE_FLAC ? 0 : 1);
		const promises = formats.map(async (format) => {
			try {
				return await single(song, format);
			} catch (e) {
				return null;
			}
		});
		const result = await Promise.all(promises);
		const url = result.find((u) => u);
		if (url) return url;
		return Promise.reject();
	} catch (e) {
		return insure().kugou.track(song);
	}
};

const cs = getManagedCacheStorage('provider/kugou');
const check = async (info) => {
	return track(await cs.cache(info, () => search(info)));
};

module.exports = { check, search };
