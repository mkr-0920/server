const select = require('./select');
const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

const api_key = process.env.MKR_API_KEY || '';

const format = (song) => ({
	id: String(song.id),
	name: song.name,
	duration: song.duration,
	album: { id: song.album_id || 0, name: song.album_name || '' },
	artists: [{ id: song.artist_id || 0, name: song.artist || '' }],
});

const search = async (info) => {
	const mainArtist = info.artists[0]?.name || '';
	const query = `"${info.name}" ${mainArtist}`.trim();
	const url = `http://127.0.0.1:5000/api/local/search?q=${encodeURIComponent(query)}&mode=any&limit=10`;
	const headers = { 'X-API-Key': api_key };

	try {
		const response = await request('GET', url, headers);
		const jsonBody = await response.json();
		if (jsonBody.code === 200 && jsonBody.data) {
			const list = (jsonBody.data.items || jsonBody.data.songs || jsonBody.data.list || []).map(format);
			const matched = select(list, info);
			if (matched) return matched.id; // Return string id natively
		}
		return Promise.reject();
	} catch (e) {
		return Promise.reject();
	}
};

const track = async (id) => {
	if (!id || typeof id !== 'string') return Promise.reject();

	const url = `http://127.0.0.1:5000/api/local/play_info/${id}`;
	const headers = { 'X-API-Key': api_key };

	try {
		const response = await request('GET', url, headers);
		const jsonBody = await response.json();
		if (jsonBody.code === 200 && jsonBody.data && jsonBody.data.url) {
			return jsonBody.data.url;
		}
		return Promise.reject();
	} catch (e) {
		return Promise.reject();
	}
};

const cs = getManagedCacheStorage('provider/mkr');

const check = async (info) => {
	try {
		const id = await cs.cache(info, () => search(info));
		const url = await track(id);
		return { url, id }; // Return standard object structure
	} catch (e) {
		return Promise.reject();
	}
};

module.exports = { check, track };
