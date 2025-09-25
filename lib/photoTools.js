import fetch from "node-fetch";
import './env.js'


// 여러 개의 장소 ID에 대해 사진 이름을 비동기적으로 가져오는 함수
async function _getPhotoNames(...spaceIds) {
    // URL을 빌드하는 함수
    const build_url = (place_id) =>`https://places.googleapis.com/v1/places/${place_id}`

    const headers = {'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_API_KEY, 'X-Goog-FieldMask': 'id,photos'}
    // 모든 장소 ID에 대해 fetch 요청을 생성
    const fetchPromises = spaceIds.map(spaceId =>
    fetch(build_url(spaceId), { method: 'GET', headers: headers })
        .then(response => {
            if (!response.ok) {
                console.error(`HTTP error! status: ${response.statusText}`);
                return null;
            }
            console.log(`Fetched data for spaceId: ${spaceId}`);
            return response.json();
        })
    );
    // 모든 fetch 요청이 완료될 때까지 기다림
    const results = await Promise.all(fetchPromises)
    var ret = [];
    // 결과에서 사진 이름을 추출
    results.forEach(result => {
        if (result.photos) {
            result.photos.forEach(photo => {
                ret.push(photo.name);
            });
        }
    })
    return ret;
}

// await _getPhotoNames("ChIJOUwYKJXvYTURRNQvZGGgndk", "ChIJ8-S81GrvYTURcGwu8ujd-i0", "ChIJm8OaS2fvYTURSnkXD7MLS9E", "ChIJ0ZX8TGfvYTURyeQbiu_HI5M").then(console.log).catch(console.error);

async function getPhotoUrls(...spaceIds) {
    // 먼저 사진 이름을 가져옴
    const photoData = await _getPhotoNames(...spaceIds);
    const build_url = (photo_name) => `https://places.googleapis.com/v1/${photo_name}/media?key=${process.env.GOOGLE_API_KEY}&maxHeightPx=400&skipHttpRedirect=true`
    var ret = {};
    // 공간 ID별로 빈 배열 초기화
    spaceIds.forEach(spaceId => {
        ret[spaceId] = [];
    })

    const fetchPromises = photoData.map(photo_name =>{
        const spaceId = photo_name.split('/')[1]; 
        // 각 사진 이름에 대해 fetch 요청 생성
        return fetch(build_url(photo_name), { method: 'GET' }).then(async response => {
                // 응답이 성공적이지 않으면 null을 반환
                if (!response.ok) {
                    console.error(`HTTP error! status: ${response.statusText}`);
                    return null;
                }
                const res = await response.json();
                res.spaceId = spaceId; // 공간 ID를 결과에 추가
                return res;
            })
        
    })

    const results = await Promise.allSettled(fetchPromises);
    results.forEach(async (res) => {
        if (res.status === 'fulfilled' && res.value.photoUri) {
            ret[res.value.spaceId].push(res.value.photoUri);
        }
    });

    
    return ret;
}

// await getPhotoUrls("ChIJOUwYKJXvYTURRNQvZGGgndk", "ChIJ8-S81GrvYTURcGwu8ujd-i0", "ChIJm8OaS2fvYTURSnkXD7MLS9E", "ChIJ0ZX8TGfvYTURyeQbiu_HI5M").then(console.log).catch(console.error);

export default {getPhotoUrls};