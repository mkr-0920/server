const crypto = require('../../crypto');
const request = require('../../request');
const { logScope } = require('../../logger');
const logger = logScope('hook:legacy');

const pretendPlay = (ctx) => {
	const { req, netease } = ctx;
	const turn = 'http://music.163.com/api/song/enhance/player/url';
	let query;
	const { id, br, e_r, header } = netease.param;
	switch (netease.crypto) {
		case 'linuxapi':
			netease.param = { ids: `["${id}"]`, br };
			query = crypto.linuxapi.encryptRequest(turn, netease.param);
			break;
		case 'eapi':
		case 'api':
			netease.param = { ids: `["${id}"]`, br, e_r, header };
			if (netease.crypto == 'eapi')
				query = crypto.eapi.encryptRequest(turn, netease.param);
			else if (netease.crypto == 'api')
				query = crypto.api.encryptRequest(turn, netease.param);
			break;
		default:
			break;
	}
	req.url = query.url;
	req.body = query.body + netease.pad;
};

const pretendPlayV1 = (ctx) => {
	const { req, netease } = ctx;
	const turn = 'http://music.163.com/api/song/enhance/player/url/v1';
	let query;
	const { id, level, immerseType, e_r, header } = netease.param;
	switch (netease.crypto) {
		case 'linuxapi':
			netease.param = {
				ids: `["${id}"]`,
				level,
				encodeType: 'flac',
				immerseType,
			};
			query = crypto.linuxapi.encryptRequest(turn, netease.param);
			break;
		case 'eapi':
		case 'api':
			netease.param = {
				ids: `["${id}"]`,
				level,
				encodeType: 'flac',
				immerseType,
				e_r,
				header,
			};
			if (netease.crypto == 'eapi')
				query = crypto.eapi.encryptRequest(turn, netease.param);
			else if (netease.crypto == 'api')
				query = crypto.api.encryptRequest(turn, netease.param);
			break;
		default:
			break;
	}
	req.url = query.url;
	req.body = query.body + netease.pad;
};

const tryCollect = async (ctx) => {
	const { req, netease } = ctx;
	const { trackIds, pid, op } = netease.param;
	const trackId = (
		Array.isArray(trackIds) ? trackIds : JSON.parse(trackIds)
	)[0];
	try {
		const response = await request(
			'POST',
			'http://music.163.com/api/playlist/manipulate/tracks',
			req.headers,
			`trackIds=[${trackId},${trackId}]&pid=${pid}&op=${op}`
		);
		const jsonBody = await response.json();
		netease.jsonBody = jsonBody;
	} catch (e) {
		if (e) logger.error(e);
	}
};

const tryLike = async (ctx) => {
	const { req, netease } = ctx;
	const { trackId } = netease.param;
	let pid = 0,
		userId = 0;
	
	try {
		const infoResponse = await request('GET', 'http://music.163.com/api/v1/user/info', req.headers);
		const infoJson = await infoResponse.json();
		userId = infoJson.userPoint.userId;
		
		const playlistResponse = await request('GET', `http://music.163.com/api/user/playlist?uid=${userId}&limit=1`, req.headers);
		const playlistJson = await playlistResponse.json();
		pid = playlistJson.playlist[0].id;
		
		const addResponse = await request(
			'POST',
			'http://music.163.com/api/playlist/manipulate/tracks',
			req.headers,
			`trackIds=[${trackId},${trackId}]&pid=${pid}&op=add`
		);
		const addJson = await addResponse.json();
		
		if (new Set([200, 502]).has(addJson.code)) {
			netease.jsonBody = { code: 200, playlistId: pid };
		}
	} catch (e) {
		if (e) logger.error(e);
	}
};

const unblockSoundEffects = (obj) => {
	const { data, code } = obj;
	if (code === 200) {
		if (Array.isArray(data))
			data.map((item) => {
				if (item.type) item.type = 1;
			});
		else if (data.type) data.type = 1;
	}
};

const unblockLyricsEffects = (obj) => {
	const { data, code } = obj;
	if (code === 200 && Array.isArray(data)) {
		data.forEach((item) => {
			if ('canUse' in item) item.canUse = true;
			if ('canNotUseReasonCode' in item) item.canNotUseReasonCode = 200;
		});
	}
};

module.exports = {
	before: (ctx, hook) => {
		const { req, netease } = ctx;
		const url = new URL(req.url);

		if (netease) {
			if (netease.path === '/api/song/enhance/download/url') pretendPlay(ctx);
			else if (netease.path === '/api/song/enhance/download/url/v1') pretendPlayV1(ctx);
		} else if (
			hook.target.host.has(url.hostname) &&
			(url.pathname.startsWith('/weapi/') || url.pathname.startsWith('/api/'))
		) {
			req.headers['X-Real-IP'] = '118.88.88.88';
			ctx.netease = {
				web: true,
				path: url.pathname.replace(/^\/weapi\//, '/api/').split('?')[0].replace(/\/\d*$/, ''),
			};
		}
	},
	after: (ctx, hook) => {
		const { proxyRes, netease } = ctx;
		if (
			netease &&
			hook.target.path.has(netease.path) &&
			proxyRes.statusCode === 200 &&
			netease.jsonBody
		) {
			if (new Set([401, 512]).has(netease.jsonBody.code) && !netease.web) {
				if (netease.path.includes('manipulate'))
					return tryCollect(ctx);
				else if (netease.path === '/api/song/like')
					return tryLike(ctx);
			} else if (netease.path.includes('/usertool/sound/')) {
				unblockSoundEffects(netease.jsonBody);
			} else if (netease.path.includes('batch')) {
				for (const key in netease.jsonBody) {
					if (key.includes('/usertool/sound/'))
						unblockSoundEffects(netease.jsonBody[key]);
				}
			} else if (netease.path.includes('/vipauth/app/auth/query')) {
				unblockLyricsEffects(netease.jsonBody);
			}
		}
	}
};
