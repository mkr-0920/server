/**
 * Does the hostname of `URL` equal `host`?
 *
 * @param url {string}
 * @param host {string}
 * @return {boolean}
 */
const isHost = (url, host) => {
	if (!url || typeof url !== 'string') return false;

	let hostname = '';
	try {
		// Try to parse it as a full URL
		hostname = new URL(url).hostname;
	} catch (e) {
		// Fallback for raw hostnames or proxy CONNECT strings (e.g., 'music.163.com:443')
		// This also safely handles relative paths (returning empty string)
		hostname = url.split('/')[0].split(':')[0];
	}

	return hostname === host || hostname.endsWith(`.${host}`);
};

/**
 * The wrapper of `isHost()` to simplify the code.
 *
 * @param url {string}
 * @return {(host: string) => boolean}
 * @see isHost
 */
const isHostWrapper = (url) => (host) => isHost(url, host);

const cookieToMap = (cookie) => {
	return cookie
		.split(';')
		.map((cookie) => cookie.trim().split('='))
		.reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {});
};

const mapToCookie = (map) => {
	return Object.entries(map)
		.map(([key, value]) => `${key}=${value}`)
		.join('; ');
};

module.exports = {
	isHost,
	isHostWrapper,
	cookieToMap,
	mapToCookie,
};
