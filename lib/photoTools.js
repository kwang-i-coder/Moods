import fetch from "node-fetch";
import './env.js'
import supabaseAdmin from './supabaseAdmin.js';

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


async function getMoodWallpaper(mood_id) {
    if(mood_id.length === 0){
        const { data:url, error } = await supabaseAdmin
            .storage
            .from('wallpaper')
            .createSignedUrl('general/Rectangle 34627910.png', 60)

        if (error) {
            console.error('Wallpaper URL 생성 실패:', error);
            return res.status(500).json({ error: 'Wallpaper URL 생성 실패' });
        }
        return {url: url.signedUrl, error: null};
    }

    const { data:mood_tags_data, error:mood_tags_error } = await supabaseAdmin
        .from('mood_tags')
        .select('*')
    if (mood_tags_error) {
        console.error('Mood tags 조회 실패:', mood_tags_error);
        return { error: new Error('Mood tags 조회 실패') };
    }
    console.log('mood_tags_data:', mood_tags_data);

    const kr_to_en = Object.fromEntries(mood_tags_data.map(tag => [tag.mood_id.trim(), tag.tag_en.trim()]));
    console.log('kr_to_en:', kr_to_en);
    const mood_id_en = mood_id.map(id => kr_to_en[id] || id)
    console.log('mood_id_en:', mood_id_en);
    let wallpaper_name = []

    for(const tag of mood_id_en){
        const { data, error } = await supabaseAdmin
            .storage
            .from('wallpaper')
            .list(tag, {
                limit: 100,
                offset: 0,
                sortBy: { column: 'name', order: 'asc' },
            })
        if (error) {
            console.error('Wallpaper 목록 조회 실패:', error);
            return { error: new Error('Wallpaper 목록 조회 실패') };
        }
        const names = data.map(item => `${tag}/${item.name}`);
        wallpaper_name.push(...names);
    }
    console.log('선택된 Wallpaper 후보:', wallpaper_name);
    if(wallpaper_name.length === 0){
        const { data:url, error } = await supabaseAdmin
            .storage
            .from('wallpaper')
            .createSignedUrl('general/Rectangle 34627910.png', 60)
            
        if (error) {
            console.error('Wallpaper URL 생성 실패:', error);
            return { error: new Error('Wallpaper URL 생성 실패') };
        }
        return {url: url.signedUrl, error: null};
    }   
    // 랜덤으로 하나 전송
    const randomWallpaper = wallpaper_name[Math.floor(Math.random() * wallpaper_name.length)];
    console.log('선택된 랜덤 Wallpaper:', randomWallpaper);
    const { data: signedUrl, error: urlError } = await supabaseAdmin.storage.from('wallpaper').createSignedUrl(randomWallpaper, 60*60*24);
    if (urlError) {
        console.error('Wallpaper URL 생성 실패:', urlError);
        return { error: new Error('Wallpaper URL 생성 실패') };
    }
    return {url: signedUrl.signedUrl, error: null};
}

// getMoodWallpaper(["활기찬"]).then(console.log).catch(console.error);
// await getPhotoUrls("ChIJOUwYKJXvYTURRNQvZGGgndk", "ChIJ8-S81GrvYTURcGwu8ujd-i0", "ChIJm8OaS2fvYTURSnkXD7MLS9E", "ChIJ0ZX8TGfvYTURyeQbiu_HI5M").then(console.log).catch(console.error);

export default {getPhotoUrls, getMoodWallpaper};