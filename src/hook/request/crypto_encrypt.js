const crypto = require('../../crypto');
const { logScope } = require('../../logger');
const logger = logScope('hook:crypto_encrypt');

module.exports = {
	after: (ctx, hook) => {
		const { req, proxyRes, netease } = ctx;
		if (
			netease &&
			hook.target.path.has(netease.path) &&
			proxyRes.statusCode === 200 &&
			netease.jsonBody
		) {
			['transfer-encoding', 'content-encoding', 'content-length']
				.filter((key) => key in proxyRes.headers)
				.forEach((key) => delete proxyRes.headers[key]);

			const inject = (key, value) => {
				if (typeof value === 'object' && value != null) {
					if (value.type === 'flac' && value.encodeType !== 'flac') {
						logger.debug(`Correcting inconsistent encodeType for song ${value.id}. Was: '${value.encodeType}', Now: 'flac'`);
						value.encodeType = 'flac';
					}
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

			try {
				let body = JSON.stringify(netease.jsonBody, inject);
				body = body.replace(
					/([^\\]"\s*:\s*)"(\d{16,})L"(\s*[}|,])/g,
					'$1$2$3'
				); // for js precision
				proxyRes.body = netease.e_r // eapi's e_r is true, needs to be encrypted
					? crypto.eapi.encrypt(Buffer.from(body))
					: body;
			} catch (error) {
				logger.error(error, `A error occurred in crypto_encrypt.after when encrypting ${req.url}.`);
			}
		}
	}
};
