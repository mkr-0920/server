const { getManagedCacheStorage } = require('../cache');

const cs = getManagedCacheStorage('hook');
cs.aliveDuration = 7 * 24 * 60 * 60 * 1000;

const requestInterceptors = [
	require('./request/migu'),
	require('./request/normalize'),
	require('./request/crypto'),
	require('./request/legacy'),
	require('./request/package'),
	require('./request/match'),
	require('./request/block'),
	require('./request/vip'),
	require('./request/crypto_encrypt'),
];

const hook = {
	request: { before: () => {}, after: () => {} },
	connect: { before: () => {}, after: () => {} },
	negotiate: { before: () => {} },
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

hook.request.before = async (ctx) => {
	for (const interceptor of requestInterceptors) {
		if (interceptor.before) {
			try {
				await interceptor.before(ctx, hook);
			} catch (error) {
				ctx.decision = 'close';
			}
			if (ctx.decision === 'close') break;
		}
	}
};

hook.request.after = async (ctx) => {
	for (const interceptor of requestInterceptors) {
		if (interceptor.after) {
			try {
				await interceptor.after(ctx, hook);
			} catch (error) {
				ctx.decision = 'close';
			}
			if (ctx.decision === 'close') break;
		}
	}
};

hook.connect.before = (ctx) => {
	const { req } = ctx;
	const url = new URL('https://' + req.url);
	if (
		[url.hostname, req.headers.host].some((host) =>
			hook.target.host.has(host)
		)
	) {
		if (parseInt(url.port, 10) === 80) {
			req.url = `${global.address || 'localhost'}:${global.port[0]}`;
			req.local = true;
		} else if (global.port[1]) {
			req.url = `${global.address || 'localhost'}:${global.port[1]}`;
			req.local = true;
		} else {
			ctx.decision = 'blank';
		}
	} else if (global.endpoint && url.href.includes(global.endpoint)) {
		ctx.decision = 'proxy';
	}
};

hook.negotiate.before = (ctx) => {
	const { req, socket, decision } = ctx;
	const url = new URL('https://' + req.url);
	const target = hook.target.host;
	if (req.local || decision) return;
	if (target.has(socket.sni) && !target.has(url.hostname)) {
		target.add(url.hostname);
		ctx.decision = 'blank';
	}
};

module.exports = hook;
