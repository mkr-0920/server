/**
 * @name hook.js
 * @description 项目的核心逻辑文件，负责拦截和修改网易云音乐的API请求与响应。
 * 包含了并行查询、智能音质比对、接口升级、客户端兼容性修复等所有高级功能。
 */

// 导入依赖模块
const crypto = require('./crypto');
const request = require('./request');
const match = require('./provider/match');
const querystring = require('querystring');
const { isHost, cookieToMap, mapToCookie } = require('./utilities');
const { getManagedCacheStorage } = require('./cache');
const { logScope } = require('./logger');

// 初始化日志记录器
const logger = logScope('hook');
const cs = getManagedCacheStorage('hook');
cs.aliveDuration = 7 * 24 * 60 * 60 * 1000; // 缓存有效期7天

// --- 1. 从环境变量中读取功能开关 ---

const ENABLE_LOCAL_VIP = ['true', 'cvip', 'svip'].includes(
	(process.env.ENABLE_LOCAL_VIP || '').toLowerCase()
);
const BLOCK_ADS = (process.env.BLOCK_ADS || '').toLowerCase() === 'true';
const DISABLE_UPGRADE_CHECK =
	(process.env.DISABLE_UPGRADE_CHECK || 'true').toLowerCase() === 'true';
const ENABLE_LOCAL_SVIP =
	(process.env.ENABLE_LOCAL_VIP || '').toLowerCase() === 'svip';
const LOCAL_VIP_UID = (process.env.LOCAL_VIP_UID || '')
	.split(',')
	.map((str) => parseInt(str, 10))
	.filter((num) => !Number.isNaN(num));

// --- 2. 定义 hook 对象结构与拦截目标 ---

const hook = {
	request: { before: () => { }, after: () => { } },
	connect: { before: () => { }, after: () => { } },
	negotiate: { before: () => { } },
	target: { host: new Set(), path: new Set() },
};

hook.target.host = new Set([
	'music.163.com', 'interface.music.163.com', 'interface3.music.163.com',
	'apm.music.163.com', 'apm3.music.163.com',
	'interface.music.163.com.163jiasu.com', 'interface3.music.163.com.163jiasu.com',
]);

hook.target.path = new Set([
	'/api/v3/playlist/detail', '/api/v3/song/detail', '/api/v6/playlist/detail',
	'/api/album/play', '/api/artist/privilege', '/api/album/privilege',
	'/api/v1/artist', '/api/v1/artist/songs', '/api/v2/artist/songs',
	'/api/artist/top/song', '/api/v1/album', '/api/album/v3/detail',
	'/api/playlist/privilege', '/api/song/enhance/player/url',
	'/api/song/enhance/player/url/v1', '/api/song/enhance/download/url',
	'/api/song/enhance/download/url/v1', '/api/song/enhance/privilege',
	'/api/ad', '/batch', '/api/batch', '/api/listen/together/privilege/get',
	'/api/playmode/intelligence/list', '/api/v1/search/get',
	'/api/v1/search/song/get', '/api/search/complex/get',
	'/api/search/complex/page', '/api/search/pc/complex/get',
	'/api/search/pc/complex/page', '/api/search/song/list/page',
	'/api/search/song/page', '/api/cloudsearch/pc',
	'/api/v1/playlist/manipulate/tracks', '/api/song/like',
	'/api/v1/play/record', '/api/playlist/v4/detail', '/api/v1/radio/get',
	'/api/v1/discovery/recommend/songs', '/api/usertool/sound/mobile/promote',
	'/api/usertool/sound/mobile/theme', '/api/usertool/sound/mobile/animationList',
	'/api/usertool/sound/mobile/all', '/api/usertool/sound/mobile/detail',
	'/api/vipauth/app/auth/query', '/api/music-vip-membership/client/vip/info',
]);

const domainList = [
	'music.163.com', 'music.126.net', 'iplay.163.com', 'look.163.com',
	'y.163.com', 'interface.music.163.com', 'interface3.music.163.com',
];

// --- 3. 核心钩子函数实现 ---

/**
 * 请求前置钩子 (Request Interception Hook - Before)
 * @description 在代理将客户端请求转发给目标服务器之前执行。
 * 主要职责是对请求进行预处理、解密，并触发后台并行搜索。
 * @param {object} ctx - 包含 `req` (客户端请求) 的上下文对象。
 */
hook.request.before = (ctx) => {
	const { req } = ctx;
	req.url =
		(req.url.startsWith('http://') || req.url.startsWith('https://')
			? ''
			: (req.socket.encrypted ? 'https:' : 'http:') + '//' + (req.headers.host || 'localhost')) + req.url;

	const url = new URL(req.url);

	if ([url.hostname, req.headers.host].some((host) => isHost(host, 'music.163.com')))
		ctx.decision = 'proxy';

	if (process.env.NETEASE_COOKIE && url.pathname.includes('url')) {
		const envCookies = cookieToMap(process.env.NETEASE_COOKIE);
		if (envCookies.MUSIC_U) {
			const clientCookies = cookieToMap(req.headers.cookie || '');
			clientCookies.MUSIC_U = envCookies.MUSIC_U;
			req.headers.cookie = mapToCookie(clientCookies);
		}
	}

	if (
		[url.hostname, req.headers.host].some((host) => hook.target.host.has(host)) &&
		req.method === 'POST' &&
		(url.pathname.startsWith('/eapi/') || url.pathname.startsWith('/api/linux/forward'))
	) {
		return request
			.read(req)
			.then((body) => (req.body = body))
			.then((body) => {
				if (body) {
					const netease = {};
					netease.pad = (body.match(/%0+$/) || [''])[0];
					if (url.pathname === '/api/linux/forward') {
						netease.crypto = 'linuxapi';
					} else if (url.pathname.startsWith('/eapi/')) {
						netease.crypto = 'eapi';
					}

					try {
						let data;
						switch (netease.crypto) {
							case 'linuxapi':
								data = JSON.parse(crypto.linuxapi.decrypt(Buffer.from(body.slice(8, body.length - netease.pad.length), 'hex')).toString());
								netease.path = new URL(data.url).pathname;
								netease.param = data.params;
								break;
							case 'eapi':
								data = crypto.eapi.decrypt(Buffer.from(body.slice(7, body.length - netease.pad.length), 'hex')).toString().split('-36cd479b6b5-');
								netease.path = data[0];
								netease.param = JSON.parse(data[1]);
								netease.e_r = (netease.param.e_r === 'true' || netease.param.e_r === true);
								break;
						}
					} catch (e) {
						logger.error(e, `Failed to decrypt request body for ${req.url}.`);
					}

					netease.path = (netease.path || '').replace(/\/\d*$/, '');
					ctx.netease = netease;

					if (netease.path && netease.path.includes('/player/url')) {
						let songId = null;
						try {
							// 兼容新旧接口，从参数中提取歌曲ID
							songId = netease.param.id || (JSON.parse(netease.param.ids || '[]'))[0];
						} catch (e) {
							logger.error(e, 'Could not parse song ID from request parameters.');
						}

						if (songId) {
							// 净化ID以兼容安卓客户端（例如移除 _0 后缀）
							const sanitizedSongId = songId.toString().match(/\d+/)?.[0] || songId.toString();

							// 启动后台并行搜索，并将任务Promise存入上下文，供 after 钩子使用
							ctx.alternativeSearchPromise = match(sanitizedSongId).catch(() => null);
							logger.info(`Started parallel search for song ${sanitizedSongId} in the background.`);
						}
					}

					if (netease.path === '/api/song/enhance/download/url') return pretendPlay(ctx);
					if (netease.path === '/api/song/enhance/download/url/v1') return pretendPlayV1(ctx);

					if (BLOCK_ADS && netease.path.startsWith('/api/ad')) ctx.decision = 'close';
					if (DISABLE_UPGRADE_CHECK && netease.path.match(/^\/api(\/v1)?\/(android|ios|osx|pc)\/(upgrade|version)/)) ctx.decision = 'close';
				}
			})
			.catch((error) => logger.error(error, `An error occurred in hook.request.before.`));
	} else if (
		hook.target.host.has(url.hostname) &&
		(url.pathname.startsWith('/weapi/') || url.pathname.startsWith('/api/'))
	) {
		req.headers['X-Real-IP'] = '118.88.88.88';
		ctx.netease = {
			web: true,
			path: url.pathname.replace(/^\/weapi\//, '/api/').split('?')[0].replace(/\/\d*$/, ''),
		};
	} else if (req.url.includes('package')) {
		try {
			const data = req.url.split('package/').pop().split('/');
			const decodedUrl = new URL(crypto.base64.decode(data[0]));
			req.url = decodedUrl.href;
			req.headers['host'] = decodedUrl.hostname;
			req.headers['cookie'] = '';
			ctx.package = { id: data[1].replace(/\.\w+/, '') };
			ctx.decision = 'proxy';
		} catch (error) {
			ctx.decision = 'close';
		}
	}
};
/**
 * 请求后置钩子：在收到目标服务器响应后执行
 * @param {object} ctx - 上下文对象
 */
hook.request.after = (ctx) => {
	const { req, proxyRes, netease, package: pkg } = ctx;
	if (
		req.headers.host === 'tyst.migu.cn' &&
		proxyRes.headers['content-range'] &&
		proxyRes.statusCode === 200
	)
		proxyRes.statusCode = 206;
	if (
		netease &&
		hook.target.path.has(netease.path) &&
		proxyRes.statusCode === 200
	) {
		return request
			.read(proxyRes, true)
			.then((buffer) =>
				buffer.length ? (proxyRes.body = buffer) : Promise.reject()
			)
			.then((buffer) => {
				const patch = (string) =>
					string.replace(
						/([^\\]"\s*:\s*)(\d{16,})(\s*[}|,])/g,
						'$1"$2L"$3'
					); // for js precision

				if (netease.e_r) {
					// eapi's e_r is true, needs to be encrypted
					netease.jsonBody = JSON.parse(
						patch(crypto.eapi.decrypt(buffer).toString())
					);
				} else {
					netease.jsonBody = JSON.parse(patch(buffer.toString()));
				}

				// logger.info(
				// 	// 使用 JSON.stringify(..., null, 2) 来格式化输出，方便阅读
				// 	{ response: JSON.stringify(netease.jsonBody, null, 2) },
				// 	'[RAW DECRYPTED RESPONSE] The original response from Netease server is:'
				// );

				if (ENABLE_LOCAL_VIP) {
					const vipPath = '/api/music-vip-membership/client/vip/info';
					if (
						netease.path === '/batch' ||
						netease.path === '/api/batch' ||
						netease.path === vipPath
					) {
						const info =
							netease.path === vipPath
								? netease.jsonBody
								: netease.jsonBody[vipPath];
						const defaultPackage = {
							iconUrl: null,
							dynamicIconUrl: null,
							isSign: false,
							isSignIap: false,
							isSignDeduct: false,
							isSignIapDeduct: false,
						};
						const vipLevel = 7; // ? months
						if (
							info &&
							(LOCAL_VIP_UID.length === 0 ||
								LOCAL_VIP_UID.includes(info.data.userId))
						) {
							try {
								const nowTime =
									info.data.now || new Date().getTime();
								const expireTime = nowTime + 31622400000;
								info.data.redVipLevel = vipLevel;
								info.data.redVipAnnualCount = 1;

								info.data.musicPackage = {
									...defaultPackage,
									...info.data.musicPackage,
									vipCode: 230,
									vipLevel,
									expireTime,
								};

								info.data.associator = {
									...defaultPackage,
									...info.data.associator,
									vipCode: 100,
									vipLevel,
									expireTime,
								};

								if (ENABLE_LOCAL_SVIP) {
									info.data.redplus = {
										...defaultPackage,
										...info.data.redplus,
										vipCode: 300,
										vipLevel,
										expireTime,
									};

									info.data.albumVip = {
										...defaultPackage,
										...info.data.albumVip,
										vipCode: 400,
										vipLevel: 0,
										expireTime,
									};
								}

								if (netease.path === vipPath)
									netease.jsonBody = info;
								else netease.jsonBody[vipPath] = info;
							} catch (error) {
								logger.debug(
									{ err: error },
									'Unable to apply the local VIP.'
								);
							}
						}
					}
				}

				if (
					new Set([401, 512]).has(netease.jsonBody.code) &&
					!netease.web
				) {
					if (netease.path.includes('manipulate'))
						return tryCollect(ctx);
					else if (netease.path === '/api/song/like')
						return tryLike(ctx);
				} else if (netease.path.includes('url')) return tryMatch(ctx);
				else if (netease.path.includes('/usertool/sound/'))
					return unblockSoundEffects(netease.jsonBody);
				else if (netease.path.includes('batch')) {
					for (const key in netease.jsonBody) {
						if (key.includes('/usertool/sound/'))
							unblockSoundEffects(netease.jsonBody[key]);
					}
				} else if (netease.path.includes('/vipauth/app/auth/query'))
					return unblockLyricsEffects(netease.jsonBody);
			})
			.then(() => {
				['transfer-encoding', 'content-encoding', 'content-length']
					.filter((key) => key in proxyRes.headers)
					.forEach((key) => delete proxyRes.headers[key]);

				const inject = (key, value) => {
					if (typeof value === 'object' && value != null) {
						if (value.type === 'flac' && value.encodeType !== 'flac') {
							logger.debug(`Correcting inconsistent encodeType for song ${value.id}. Was: '${value.encodeType}', Now: 'flac'`);
							value.encodeType = 'flac';
						}
						//if ('level' in value) value['level'] = 'flac';
						//if ('br' in value) value['level'] = 999000;
						if ('cp' in value) value['cp'] = 1;
						if ('fee' in value) value['fee'] = 0;
						if (
							'downloadMaxbr' in value &&
							value['downloadMaxbr'] === 0
						)
							value['downloadMaxbr'] = 320000;
						if (
							'dl' in value &&
							'downloadMaxbr' in value &&
							value['dl'] < value['downloadMaxbr']
						)
							value['dl'] = value['downloadMaxbr'];
						if ('playMaxbr' in value && value['playMaxbr'] === 0)
							value['playMaxbr'] = 320000;
						if (
							'pl' in value &&
							'playMaxbr' in value &&
							value['pl'] < value['playMaxbr']
						)
							value['pl'] = value['playMaxbr'];
						if ('sp' in value && 'st' in value && 'subp' in value) {
							// batch modify
							value['sp'] = 7;
							value['st'] = 0;
							value['subp'] = 1;
						}
						if (
							'start' in value &&
							'end' in value &&
							'playable' in value &&
							'unplayableType' in value &&
							'unplayableUserIds' in value
						) {
							value['start'] = 0;
							value['end'] = 0;
							value['playable'] = true;
							value['unplayableType'] = 'unknown';
							value['unplayableUserIds'] = [];
						}
						if ('noCopyrightRcmd' in value)
							value['noCopyrightRcmd'] = null;
						if ('payed' in value && value['payed'] == 0)
							value['payed'] = 1;
						if ('flLevel' in value && value['flLevel'] === 'none')
							value['flLevel'] = 'exhigh';
						if ('plLevel' in value && value['plLevel'] === 'none')
							value['plLevel'] = 'exhigh';
						if ('dlLevel' in value && value['dlLevel'] === 'none')
							value['dlLevel'] = 'exhigh';
					}
					return value;
				};

				let body = JSON.stringify(netease.jsonBody, inject);
				body = body.replace(
					/([^\\]"\s*:\s*)"(\d{16,})L"(\s*[}|,])/g,
					'$1$2$3'
				); // for js precision
				proxyRes.body = netease.e_r // eapi's e_r is true, needs to be encrypted
					? crypto.eapi.encrypt(Buffer.from(body))
					: body;
			})
			.catch(
				(error) =>
					error &&
					logger.error(
						error,
						`A error occurred in hook.request.after when hooking ${req.url}.`
					)
			);
	} else if (pkg) {
		if (new Set([201, 301, 302, 303, 307, 308]).has(proxyRes.statusCode)) {
			return request(
				req.method,
				parse(req.url).resolve(proxyRes.headers.location),
				req.headers
			).then((response) => (ctx.proxyRes = response));
		} else if (/p\d+c*\.music\.126\.net/.test(req.url)) {
			proxyRes.headers['content-type'] = 'audio/*';
		}
	}
};

/**
 * CONNECT请求前置钩子
 * @param {object} ctx - 上下文对象
 */
hook.connect.before = (ctx) => {
	const { req } = ctx;
	// 核心修改：使用 new URL()
	const url = new URL('https://' + req.url);
	if (
		[url.hostname, req.headers.host].some((host) =>
			hook.target.host.has(host)
		)
	) {
		if (parseInt(url.port, 10) === 80) { // 修正：使用基数10
			req.url = `${global.address || 'localhost'}:${global.port[0]}`;
			req.local = true;
		} else if (global.port[1]) {
			req.url = `${global.address || 'localhost'}:${global.port[1]}`;
			req.local = true;
		} else {
			ctx.decision = 'blank';
		}
	} else if (url.href.includes(global.endpoint)) ctx.decision = 'proxy';
};

/**
 * TLS协商前置钩子
 * @param {object} ctx - 上下文对象
 */
hook.negotiate.before = (ctx) => {
	const { req, socket, decision } = ctx;
	// 核心修改：使用 new URL()
	const url = new URL('https://' + req.url);
	const target = hook.target.host;
	if (req.local || decision) return;
	if (target.has(socket.sni) && !target.has(url.hostname)) {
		target.add(url.hostname);
		ctx.decision = 'blank';
	}
};

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

const tryCollect = (ctx) => {
	const { req, netease } = ctx;
	const { trackIds, pid, op } = netease.param;
	const trackId = (
		Array.isArray(trackIds) ? trackIds : JSON.parse(trackIds)
	)[0];
	return request(
		'POST',
		'http://music.163.com/api/playlist/manipulate/tracks',
		req.headers,
		`trackIds=[${trackId},${trackId}]&pid=${pid}&op=${op}`
	)
		.then((response) => response.json())
		.then((jsonBody) => {
			netease.jsonBody = jsonBody;
		})
		.catch((e) => e && logger.error(e));
};

const tryLike = (ctx) => {
	const { req, netease } = ctx;
	const { trackId } = netease.param;
	let pid = 0,
		userId = 0;
	return request('GET', 'http://music.163.com/api/v1/user/info', req.headers)
		.then((response) => response.json())
		.then((jsonBody) => {
			userId = jsonBody.userPoint.userId;
			return request(
				'GET',
				`http://music.163.com/api/user/playlist?uid=${userId}&limit=1`,
				req.headers
			).then((response) => response.json());
		})
		.then((jsonBody) => {
			pid = jsonBody.playlist[0].id;
			return request(
				'POST',
				'http://music.163.com/api/playlist/manipulate/tracks',
				req.headers,
				`trackIds=[${trackId},${trackId}]&pid=${pid}&op=add`
			).then((response) => response.json());
		})
		.then((jsonBody) => {
			if (new Set([200, 502]).has(jsonBody.code)) {
				netease.jsonBody = { code: 200, playlistId: pid };
			}
		})
		.catch((e) => e && logger.error(e));
};

const computeHash = (task) =>
	request('GET', task.url).then((response) => crypto.md5.pipe(response));

const tryMatch = (ctx) => {
    const { req, netease, alternativeSearchPromise } = ctx;
    const { jsonBody } = netease;
    const min_br = Number(process.env.MIN_BR) || 0;
    let tasks;
    let target = 0;

    const inject = (item) => {
        item.flag = 0;

        // 如果没有并行搜索任务（例如处理非歌曲链接API），则直接跳过
        if (!alternativeSearchPromise) {
            if (item.code === 200 && !item.freeTrialInfo) {
                logger.info(
                    { id: item.id, source: 'Netease (Original)', br: item.br, url: item.url },
                    `[PASSTHROUGH] Using Netease source for song ${item.id} (no alternative search).`
                );
            }
            return;
        }

        // 等待我们预先启动的后台搜索任务
        return alternativeSearchPromise.then((matchedSong) => {
            logger.debug({ matchedSong }, '[DEBUG] Full content of matchedSong object:');

            // --- 全新的“强制替换”核心逻辑 ---
            if (matchedSong) {
                // 只要匹配成功 (matchedSong 不为 null)，就无条件使用它
                logger.debug(
                    { id: item.id, source: matchedSong.source || 'Matched Provider', br: matchedSong.br },
                    `[FORCE REPLACE] Using matched source for song ${item.id}. Overwriting Netease response.`
                );

                // 使用匹配到的结果，更新 item 对象的属性
                item.url = matchedSong.url; // 这个URL将在下面被包装
                item.br = matchedSong.br;
                item.size = matchedSong.size;
                item.md5 = matchedSong.md5;
                item.type = 'flac';
                item.code = 200;
                item.freeTrialInfo = null;
                
                // 使用 /package/ 代理流来解决播放中断问题
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
                // 如果没有设置 endpoint，item.url 保持为 realUrl
                
            } else {
                // 如果匹配失败 (matchedSong 为 null)，则记录警告，并使用网易云的原始响应
                logger.warn(
                    { id: item.id, neteaseResponse: { code: item.code, br: item.br } },
                    `[REPLACE FAILED] Matched source returned null. Falling back to original Netease response.`
                );
            }

            // 打印最终将发送给客户端的数据
            logger.debug(
                {
                    id: item.id,
                    source: matchedSong ? (matchedSong.source || 'Matched Provider') : 'Netease (Original)',
                    final_br: item.br,
                    final_url: item.url
                },
                `[FINAL DATA] Data for song ${item.id}.`
            );
        })
        .catch((e) => e && logger.error(e));
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
    return Promise.all(tasks).catch((e) => e && logger.error(e));
};

const unblockSoundEffects = (obj) => {
	logger.debug('unblockSoundEffects() has been triggered.');
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
	logger.debug('unblockLyricsEffects() has been triggered.');
	const { data, code } = obj;
	if (code === 200 && Array.isArray(data)) {
		data.forEach((item) => {
			if ('canUse' in item) item.canUse = true;
			if ('canNotUseReasonCode' in item) item.canNotUseReasonCode = 200;
		});
	}
};

module.exports = hook;
