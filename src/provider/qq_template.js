/**
 * @name qq.js
 * @description QQ音乐音源提供者。
 * 通过请求您自定义的后端API来获取音源URL。
 */

const request = require('../request');
const { getManagedCacheStorage } = require('../cache');
const { logScope } = require('../logger');

const logger = logScope('provider/qq');

const fetchTrackFromAPI = async (info) => {
    const songName = info.name;
    const artistName = info.artists.map(artist => artist.name).join(' / ');
    const albumName = info.album ? info.album.name : null;

    const searchQuery = `${artistName} - ${songName}`;
    let url = `http://172.17.0.1:5000/api/qq?q=${encodeURIComponent(searchQuery)}`;
    if (albumName) {
        url += `&album=${encodeURIComponent(albumName)}`;
    }

    const headers = {
        'X-API-Key': ''
    };

    try {
        const response = await request('GET', url, headers);
        if (response.statusCode < 200 || response.statusCode > 299) {
            throw new Error(`您的自定义API [${url}] 返回了错误状态码: ${response.statusCode}`);
        }
        
        let jsonBody;
        try {
            jsonBody = await response.json();
        } catch (e) {
            const rawBody = await response.text();
            logger.error({ rawBody }, '无法将您的自定义API响应解析为JSON。');
            throw new Error('从您的自定义API收到了无效的JSON响应。');
        }

        if (jsonBody && jsonBody.code === 200 && jsonBody.data && jsonBody.data.urls) {
            const musicUrls = jsonBody.data.urls;
            let selectedUrl = null;

            // 按“母带 > 无损 > 320k > 128k”的优先级选择音源URL
            if (musicUrls.master) {
                selectedUrl = musicUrls.master;
            } else if (musicUrls.flac) {
                selectedUrl = musicUrls.flac;
            } else if (musicUrls['320']) {
                selectedUrl = musicUrls['320'];
            } else if (musicUrls['128']) {
                selectedUrl = musicUrls['128'];
            }

            if (selectedUrl) {
                return {
                    url: selectedUrl
                };
            }
        }
        
        throw new Error('未在您的API响应中找到有效的播放链接');
    } catch (error) {
        logger.error(error, `请求您的自定义API失败: ${info.name}`);
        throw error;
    }
};

const cs = getManagedCacheStorage('provider/qq');

const check = async (info) => {
	return fetchTrackFromAPI(info);
};

module.exports = { check };
