const request = require('../request');
const { getManagedCacheStorage } = require('../cache');

const track = (info) => {
    const url = 'http://172.17.0.1:5000/api/netease?level=jymaster&id=' + info.id;

    // 1. 创建包含API密钥的headers对象
    const headers = {
        'X-API-Key': ''
    };

    // 2. 将headers对象传给您的request函数
    return request('GET', url, headers)
        .then(response => response.json())
        .then(jsonBody => {
            // 3. 修正解析API响应的逻辑
            if (jsonBody.code === 200 && jsonBody.data && jsonBody.data.url) {
                return jsonBody.data.url; // URL在'data'对象内部
            } else {
                // 如果请求失败，用API返回的错误信息来拒绝Promise
                const errorMessage = jsonBody.message || 'API返回了错误或无效数据';
                return Promise.reject(new Error(errorMessage));
            }
        })
        .catch(error => {
            console.error("调用网易云API失败:", error);
            // 重新抛出错误，以便调用代码能知道操作失败了
            return Promise.reject(error);
        });
};

const cs = getManagedCacheStorage('provider/pyncmd');
const check = (info) => cs.cache(info, () => track(info));

module.exports = { check };