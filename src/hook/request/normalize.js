const { isHost, cookieToMap, mapToCookie } = require('../../utilities');

module.exports = {
	before: (ctx) => {
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
	}
};
