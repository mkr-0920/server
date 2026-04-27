const match = require('../../provider/match');
const querystring = require('querystring');
const crypto = require('../../crypto');
const { logScope } = require('../../logger');
const logger = logScope('hook:match');

module.exports = {
	before: async (ctx) => {
	},
	after: async (ctx, hook) => {
		const { req, proxyRes, netease } = ctx;
		if (
			netease &&
			hook.target.path.has(netease.path) &&
			proxyRes.statusCode === 200 &&
			netease.jsonBody &&
			netease.path.includes('url') &&
			!(new Set([401, 512]).has(netease.jsonBody.code) && !netease.web)
		) {
			const { jsonBody } = netease;
			const min_br = Number(process.env.MIN_BR) || 0;
			let tasks;
			let target = 0;

			const inject = async (item) => {
				item.flag = 0;
				if (
					(item.code !== 200 || item.freeTrialInfo || item.br < min_br) &&
					(target === 0 || item.id === target)
				) {
					try {
						const matchedSong = await match(item.id);
						if (matchedSong) {
							logger.debug(
								{ id: item.id, source: matchedSong.source || 'Matched Provider', br: matchedSong.br },
								`[FORCE REPLACE] Using matched source for song ${item.id}. Overwriting Netease response.`
							);
							item.url = matchedSong.url;
							item.br = matchedSong.br || 128000;
							item.size = matchedSong.size;
							item.md5 = matchedSong.md5;
							item.type = matchedSong.br === 999000 ? 'flac' : 'mp3';
							item.code = 200;
							item.freeTrialInfo = null;

							const realUrl = matchedSong.url;
							if (global.endpoint) {
								let os = '';
								try {
									let { header } = netease.param;
									header = typeof header === 'string' ? JSON.parse(header) : header;
									const cookie = querystring.parse(req.headers.cookie.replace(/\s/g, ''), ';');
									os = header.os || cookie.os;
								} catch (e) { }

								const encodedUrl = crypto.base64.encode(realUrl);
								if (os === 'pc' || os === 'uwp') {
									item.url = `${global.endpoint.replace('https://', 'http://')}/package/${encodedUrl}/${item.id}.${item.type}`;
								} else {
									item.url = `${global.endpoint}/package/${encodedUrl}/${item.id}.${item.type}`;
								}
							}
						} else {
							logger.warn(
								{ id: item.id, neteaseResponse: { code: item.code, br: item.br } },
								`[REPLACE FAILED] Matched source returned null. Falling back to original Netease response.`
							);
						}
					} catch (e) {
						if (e) logger.error(e);
					}
				} else {
					if (item.code === 200 && !item.freeTrialInfo) {
						logger.info(
							{ id: item.id, source: 'Netease (Original)', br: item.br, url: item.url },
							`[PASSTHROUGH] Using Netease source for song ${item.id} (VIP/Free track).`
						);
					}
				}
			};

			if (!Array.isArray(jsonBody.data)) {
				tasks = [inject(jsonBody.data)];
			} else if (netease.path.includes('download')) {
				jsonBody.data = jsonBody.data[0];
				tasks = [inject(jsonBody.data)];
			} else {
				target = netease.web ? 0 : parseInt(((Array.isArray(netease.param.ids) ? netease.param.ids : JSON.parse(netease.param.ids))[0] || 0).toString().replace('_0', ''));
				tasks = jsonBody.data.map((item) => inject(item));
			}
			
			try {
				await Promise.all(tasks);
			} catch (e) {
				if (e) logger.error(e);
			}
		}
	}
};
