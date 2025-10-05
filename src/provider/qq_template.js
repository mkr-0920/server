const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

/**
 * 直接从您的后端API搜索并获取音源链接
 * @param {object} info - 包含歌曲、歌手和专辑信息的结构化对象
 */
const fetchTrackFromAPI = (info) => {
    // 1. 从 info 对象中提取歌曲、歌手和专辑信息
    const songName = info.name;
    const artistName = info.artists.map(artist => artist.name).join(' / ');
    const albumName = info.album ? info.album.name : null;

    // 2. 构建您的后端API所需的查询参数
    const searchQuery = `${artistName} - ${songName}`;
    let url = `http://172.17.0.1:5000/api/qq?q=${encodeURIComponent(searchQuery)}`;
    if (albumName) {
        url += `&album=${encodeURIComponent(albumName)}`;
    }

    // 3. 设置包含API密钥的请求头
    const headers = {
        'X-API-Key': ''
    };

    // 4. 发起请求并处理响应
    return request('GET', url, headers)
        .then(response => response.json())
        .then(jsonBody => {
            if (jsonBody && jsonBody.code === 200 && jsonBody.data && jsonBody.data.urls) {
                const musicUrls = jsonBody.data.urls;
                let selectedUrl = null;
                let qualityLabel = null;

                // --- 核心修改：按优先级选择URL，并同时记录品质标签 ---
                if (musicUrls.master) {
                    selectedUrl = musicUrls.master;
                    qualityLabel = 'master';
                } else if (musicUrls.flac) {
                    selectedUrl = musicUrls.flac;
                    qualityLabel = 'flac';
                } else if (musicUrls['320']) {
                    selectedUrl = musicUrls['320'];
                    qualityLabel = '320k';
                } else if (musicUrls['128']) {
                    selectedUrl = musicUrls['128'];
                    qualityLabel = '128k';
                }
                // --- 修改结束 ---

                if (selectedUrl) {
                    // 成功找到了URL，返回一个包含所有必需信息的对象
                    // 注意：br 和 size 等信息会在 match.js 的 check 函数中被自动获取，这里我们只需提供 URL 和品质标签
                    return {
                        url: selectedUrl,
                        qualityLabel: qualityLabel // <-- 关键！附加上我们的品质标签
                    };
                }
            }

            return Promise.reject('未在API响应中找到有效的播放链接');
        });
};

const cs = getManagedCacheStorage('provider/qq');

/**
 * 检查并获取歌曲音源的主函数 (带缓存)
 * @param {object} info 
 */
const check = (info) =>
    cs.cache(info, () => fetchTrackFromAPI(info)) // 直接调用我们新的API函数
        .catch((error) => {
            console.error("从后端获取QQ音乐音源失败:", error);
            // 捕获错误，避免程序崩溃
        });

// 只需导出 check 函数作为公共接口
module.exports = { check };
