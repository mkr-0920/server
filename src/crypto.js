/**
 * @name crypto.js
 * @description 负责项目中所有加密、解密、哈希和签名算法的核心模块。
 * 实现了网易云 eapi/linuxapi、咪咕 miguapi 等多种加密方案。
 */

'use strict';

// 导入Node.js核心模块
const crypto = require('crypto');
const querystring = require('querystring'); // 使用 querystring.stringify 替代 bodyify

// --- 加密算法常量 ---

// eapi 使用的 AES-128-ECB 密钥
const eapiKey = 'e82ckenh8dichen8';
// linuxapi 使用的 AES-128-ECB 密钥
const linuxapiKey = 'rFgB&h#%2?^eDg:Q';
// 咪咕使用的 RSA 公钥
const miguPublicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC8asrfSaoOb4je+DSmKdriQJKWVJ2oDZrs3wi5W67m3LwTB9QVR+cE3XWU21Nx+YBxS0yun8wDcjgQvYt625ZCcgin2ro/eOkNyUOTBIbuj9CvMnhUYiR61lC1f1IGbrSYYimqBVSjpifVufxtx/I3exReZosTByYp4Xwpb1+WAQIDAQAB\n-----END PUBLIC KEY-----';

// --- 底层加解密函数 ---

/**
 * AES-128-ECB 解密函数
 * @param {Buffer} buffer - 需要解密的Buffer
 * @param {string} key - 密钥
 * @returns {Buffer} 解密后的Buffer
 */
const decrypt = (buffer, key) => {
	const decipher = crypto.createDecipheriv('aes-128-ecb', key, ''); // ECB模式IV为null或空字符串
	return Buffer.concat([decipher.update(buffer), decipher.final()]);
};

/**
 * AES-128-ECB 加密函数
 * @param {Buffer} buffer - 需要加密的Buffer
 * @param {string} key - 密钥
 * @returns {Buffer} 加密后的Buffer
 */
const encrypt = (buffer, key) => {
	const cipher = crypto.createCipheriv('aes-128-ecb', key, ''); // ECB模式IV为null或空字符串
	return Buffer.concat([cipher.update(buffer), cipher.final()]);
};

// --- API 加密模块导出 ---

module.exports = {
	/**
	 * 网易云 EAPI 加密方案
	 */
	eapi: {
		encrypt: (buffer) => encrypt(buffer, eapiKey),
		decrypt: (buffer) => decrypt(buffer, eapiKey),
		/**
		 * 加密EAPI请求
		 * @param {string} urlString - 原始请求URL
		 * @param {object} object - 请求参数对象
		 * @returns {{url: string, body: string}} - 加密后的URL和请求体
		 */
		encryptRequest: (urlString, object) => {
			// 核心修改：使用 new URL()
			const url = new URL(urlString);
			const text = JSON.stringify(object);
			const message = `nobody${url.pathname}use${text}md5forencrypt`;
			const digest = crypto
				.createHash('md5')
				.update(message)
				.digest('hex');
			const data = `${url.pathname}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;

			return {
				url: url.href.replace(/\w*api/, 'eapi'),
				body: querystring.stringify({
					params: module.exports.eapi
						.encrypt(Buffer.from(data))
						.toString('hex')
						.toUpperCase(),
				}),
			};
		},
	},
	
	/**
	 * 网易云 WEAPI 加密方案 (此文件未实现，仅作为结构占位)
	 */
	api: {
		encryptRequest: (urlString, object) => {
			// 核心修改：使用 new URL()
			const url = new URL(urlString);
			return {
				url: url.href.replace(/\w*api/, 'api'),
				body: querystring.stringify(object),
			};
		},
	},

	/**
	 * 网易云 Linux API 加密方案
	 */
	linuxapi: {
		encrypt: (buffer) => encrypt(buffer, linuxapiKey),
		decrypt: (buffer) => decrypt(buffer, linuxapiKey),
		/**
		 * 加密 Linux API 请求
		 * @param {string} urlString - 原始请求URL
		 * @param {object} object - 请求参数对象
		 * @returns {{url: string, body: string}} - 加密后的URL和请求体
		 */
		encryptRequest: (urlString, object) => {
			// 核心修改：使用 new URL()
			const url = new URL(urlString);
			const text = JSON.stringify({
				method: 'POST',
				url: url.href,
				params: object,
			});

			return {
				// 核心修改：使用 new URL() 构造新路径
				url: new URL('/api/linux/forward', url).href,
				body: querystring.stringify({
					eparams: module.exports.linuxapi
						.encrypt(Buffer.from(text))
						.toString('hex')
						.toUpperCase(),
				}),
			};
		},
	},

	/**
	 * 咪咕 API 加密方案
	 */
	miguapi: {
		encryptBody: (object) => {
			const text = JSON.stringify(object);
			// EVP_BytesToKey-like 密钥派生函数
			const derive = (password, salt, keyLength, ivSize) => {
				salt = salt || Buffer.alloc(0);
				const keySize = keyLength / 8;
				const repeat = Math.ceil((keySize + ivSize * 8) / 32);
				const buffer = Buffer.concat(
					Array(repeat)
						.fill(null)
						.reduce(
							(result) =>
								result.concat(
									crypto
										.createHash('md5')
										.update(
											Buffer.concat([
												result.slice(-1)[0],
												password,
												salt,
											])
										)
										.digest()
								),
							[Buffer.alloc(0)]
						)
				);
				return {
					key: buffer.slice(0, keySize),
					iv: buffer.slice(keySize, keySize + ivSize),
				};
			};

			const password = Buffer.from(crypto.randomBytes(32).toString('hex'));
			const salt = crypto.randomBytes(8);
			const secret = derive(password, salt, 256, 16);
			const cipher = crypto.createCipheriv(
				'aes-256-cbc',
				secret.key,
				secret.iv
			);
			
			return querystring.stringify({
				data: Buffer.concat([
					Buffer.from('Salted__'),
					salt,
					cipher.update(Buffer.from(text)),
					cipher.final(),
				]).toString('base64'),
				secKey: crypto
					.publicEncrypt(
						{ key: miguPublicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
						password
					)
					.toString('base64'),
			});
		},
	},
	
	/**
	 * Base64 URL Safe 编码/解码
	 */
	base64: {
		encode: (text, charset) =>
			Buffer.from(text, charset)
				.toString('base64')
				.replace(/\+/g, '-')
				.replace(/\//g, '_'),
		decode: (text, charset) =>
			Buffer.from(
				text.replace(/-/g, '+').replace(/_/g, '/'),
				'base64'
			).toString(charset),
	},
	
	/**
	 * 网易云旧版封面图片URL解密 (已较少使用)
	 */
	uri: {
		retrieve: (id) => {
			id = id.toString().trim();
			const key = '3go8&$8*3*3h0k(2)2';
			const string = Array.from(Array(id.length).keys())
				.map((index) =>
					String.fromCharCode(
						id.charCodeAt(index) ^
						key.charCodeAt(index % key.length)
					)
				)
				.join('');
			const result = crypto
				.createHash('md5')
				.update(string)
				.digest('base64')
				.replace(/\//g, '_')
				.replace(/\+/g, '-');
			return `http://p1.music.126.net/${result}/${id}`;
		},
	},
	
	/**
	 * MD5 哈希工具
	 */
	md5: {
		digest: (value) => crypto.createHash('md5').update(value).digest('hex'),
		pipe: (source) =>
			new Promise((resolve, reject) => {
				const digest = crypto.createHash('md5').setEncoding('hex');
				source
					.pipe(digest)
					.on('error', (error) => reject(error))
					.once('finish', () => resolve(digest.read()));
			}),
	},
	
	/**
	 * SHA1 哈希工具
	 */
	sha1: {
		digest: (value) =>
			crypto.createHash('sha1').update(value).digest('hex'),
	},
	
	/**
	 * 随机数/UUID 生成工具
	 */
	random: {
		hex: (length) =>
			crypto
				.randomBytes(Math.ceil(length / 2))
				.toString('hex')
				.slice(0, length),
		uuid: () => crypto.randomUUID(),
	},
};

// 动态加载酷我加密模块 (如果存在)
try {
	module.exports.kuwoapi = require('./kwDES');
} catch (e) {
	// 模块不存在则忽略
}