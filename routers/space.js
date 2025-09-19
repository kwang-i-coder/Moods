import express from "express"
import supabase from "../lib/supabaseClient.js"
import verifySupabaseJWT from "../lib/verifyJWT.js";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

router.use(express.json());

router.get('/near', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /spaces/near');
    // 근처 장소 조회 라우트
    var {lat, lng, rad, type} = req.query;
    // lat, lng는 필수 파라미터
    if(!lat || !lng) {
        const err = new Error("위치 정보가 부족합니다.");
        err.status = 400;
        return next(err);
    }
    // 선택 파라미터는 기본값 적용
    if(!rad) {
        rad = 500; // 기본 반경 500m
    }
    if(!type) {
        type = ['cafe', 'library']
    }
    if(!Array.isArray(type)) {
        type = [type]; // 단일 타입을 배열로 변환
    }
    const url = "https://places.googleapis.com/v1/places:searchNearby";
    const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
    "X-Goog-FieldMask": "places.location,places.id,places.displayName,places.types,places.location"
    };
    const data = {
    "includedTypes": type,
    "languageCode": 'ko',
    "regionCode": 'kr',
    "maxResultCount": 10,
    "locationRestriction": {
        "circle": {
            "center": {
                "latitude": lat,
                "longitude": lng
            },
            "radius": rad
        }
    }
}
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        var result = await response.json();
        result = result.places || [];
        if(result.length > 0) {
            for(var idx in result) {
                let data = {};
                data.space_id = result[idx].id;
                data.name = result[idx].displayName.text;
                data.distance = getDistanceFromLatLonInMeters(lat, lng, result[idx].location.latitude, result[idx].location.longitude);
                data.location = {
                        lat: result[idx].location?.latitude,
                        lng: result[idx].location?.longitude
                    };
                for(const t of type) {
                    if(result[idx].types.includes(t)) {
                        data.type = t;
                        break; // 모든 타입을 추가
                    }
                }

                // supabase에 upsert하기 (있는 공간이면 그대로, 없는 공간이면 추가)
                const {data:space_data,error} = await supabase.from('spaces').upsert({
                    id: data.space_id,
                    is_public: true,
                }).select('*').single();
                if(error) {
                    error.status = 500;
                    return next(error);
                }

                // 분위기가 아직 분석되지 않았다면 워커에 작업 넘김
                // if(space_data.mood_tag_status==="pending"){
                //     await fetch('http://localhost:8000/jobs', {method:"POST", body:JSON.stringify({place_id:data.space_id})})
                // }

                result[idx] = data;
            }
            // 거리 기준으로 정렬
            result.sort((a, b) => a.distance - b.distance);
        }
        var {data: private_spaces, error} = await supabase
            .from('spaces')
            .select('*')
            .eq('is_public', false)
            .eq('user_id', req.user.sub) // 로그인한 사용자에 한해 개인 장소 포함
            .setHeader('Authorization', req.headers.authorization);
        if(error) {
            error.status = 500;
            error.message = `개인 장소 조회 실패: ${error.message}`;
            return next(error);
        }
        // 개인 장소 중에서 반경 내에 있는 장소 추가
        private_spaces = private_spaces.map(space => {
            return {
                space_id: space.id,
                name: space.name,
                distance: getDistanceFromLatLonInMeters(lat, lng, space.lat, space.lng),
                location: {
                    lat: space.lat,
                    lng: space.lng
                },
                type: 'private'
            }
        })
        console.log(private_spaces);
        private_spaces = private_spaces.filter(space => (space.distance <= rad))
        
        result.push(...private_spaces);

        return res.status(200).json({
            success: true,
            places: result
        });
    } catch (error) {
        error.status = 500;
        error.message = "근처 장소 조회 오류: " + error.message;
        return next(error);
    }
})

router.get('/detail', verifySupabaseJWT, async (req, res, next) => {
    console.log('[라우트 호출] GET /spaces/detail');
    // 장소 상세 정보 조회 라우트
    let { space_id } = req.query;
    if (!space_id) {
        const err = new Error("장소 ID가 필요합니다.");
        err.status = 400;
        return next(err);
    }
    if (!Array.isArray(space_id)) {
        space_id = [space_id]; // 단일 ID를 배열로 변환
    }

    try {
        // DB에서 기본 공간 정보 조회
        const { error, data: spacesFromDb } = await supabase
            .from('spaces')
            .select('*')
            .in('id', space_id)
            .eq('is_public', false)
            .setHeader('Authorization', req.headers.authorization);

        if (error) {
            const err = new Error(`DB 조회 실패: ${error.message}`);
            err.status = 500;
            return next(err);
        }

        const privateSpacesData = [];
        const publicSpacePromises = [];
        const googleApiHeaders = {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
            "X-Goog-FieldMask": "id,displayName,formattedAddress,types,location",
        };

        // 개인 장소 데이터 추가
        for (const space of spacesFromDb) {
            privateSpacesData.push({
                space_id: space.id,
                name: space.name,
                formatted_address: space.address,
                types: 'private',
                location: {
                    lat: space.lat,
                    lng: space.lng
                }
            });
        }

        const privateSpaces = spacesFromDb.map(space => space.id);
        const publicSpaces = space_id.filter(id => !privateSpaces.includes(id));



        // 공공 장소 데이터 추가
        for(const id of publicSpaces){
            const url = `https://places.googleapis.com/v1/places/${id}?languageCode=ko&regionCode=kr`;
            publicSpacePromises.push(fetch(url, { method: 'GET', headers: googleApiHeaders }));
        }

        // Google Places API 병렬 호출 및 결과 처리
        const publicSpacesResults = await Promise.allSettled(publicSpacePromises);
        const publicSpacesData = [];

        for (const result of publicSpacesResults) {
            if (result.status === 'fulfilled' && result.value.ok) {
                const placeDetails = await result.value.json();
                let primaryType = 'unknown';
                for (const t of placeDetails.types || []) {
                    if (['cafe', 'library'].includes(t)) {
                        primaryType = t;
                        break;
                    }
                }
                publicSpacesData.push({
                    space_id: placeDetails.id,
                    name: placeDetails.displayName?.text,
                    formatted_address: placeDetails.formattedAddress,
                    types: primaryType,
                    location: {
                        lat: placeDetails.location?.latitude,
                        lng: placeDetails.location?.longitude
                    }
                });
            } else {
                const reason = result.reason || `Status: ${result.value?.status}`;
                const err = new Error("Google Places API 호출 실패: " + reason);
                err.status = 500;
                return next(err);
            }
        }

        // 모든 데이터 취합 후 응답
        const allData = [...privateSpacesData, ...publicSpacesData];
        return res.status(200).json({ success: true, data: allData });

    } catch (e) {
        e.status = 500;
        e.message = "장소 상세 정보 처리 중 서버 오류: " + e.message;
        return next(e);
    }
});

// // 분위기는 자주 호출하므로 공간 상세정보와 분리하여 처리
// router.get('/mood', async (req, res) => {
//     console.log('[라우트 호출] GET /spaces/mood');
//     // 장소 분위기 조회 라우트
//     let { space_id } = req.query;
//     if (!space_id) {
//         return res.status(400).json({ error: "장소 ID가 필요합니다." });
//     }
//     if (!Array.isArray(space_id)) {
//         space_id = [space_id]; // 단일 ID를 배열로 변환
//     }
//     try {
//         const {data, error} = await supabase
//             .from('spaces')
//             .select('id','mood_tag_status')
//             .in('id', space_id)
//             .eq('is_public', true)
//         const mood_data = []
//         for(const space of data){
//             let data_per_space = {}
//             data_per_space.space_id = space.id
//             data_per_space.mood_tag_status = space.mood_tag_status

//             if(space.mood_tag_status === 'pending'){
//                 mood_data.push(data_per_space)
//                 await fetch('http://localhost:8000/jobs', {method:"POST", body:JSON.stringify({place_id:data.id})})
//                 continue
//             }
//             if(space.mood_tag_status === "queued" || space.mood_tag_status === "in-progress"){
                
//             }
//         }
//     } catch (error) {
//         console.error("장소 분위기 조회 오류:", error);
//         return res.status(500).json({error: "서버 오류"});
//     }

// })

router.get('/visited', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /spaces/visited');
    const {from, to} = req.query;
    try {
        const {data, error} = await supabase
            .from('visited_spaces')
            .select('space_id')
            .gte('recent_visit', from)
            .lte('recent_visit', to)
            .setHeader('Authorization', req.headers.authorization);
        if (error) {
            error.status = 400;
            return next(error);
        }
        res.json({
            success: true,
            visited_spaces: data.map(item => item.space_id)
        });
    } catch (error) {
        error.status = 500;
        error.message = "방문 장소 조회 오류: " + error.message;
        return next(error);
    }
});

router.patch('/private-spaces/:space_id', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] PATCH /spaces/favorite-spaces/:space_id');
    const { space_id } = req.params;
    const columns_to_update = {};
    for (const field of ['name', 'address']){
        if (req.body[field]) {
            columns_to_update[field] = req.body[field];
        }
    };
    const {error, data} = await supabase
        .from('spaces')
        .update(columns_to_update)
        .eq('id', space_id)
        .eq('user_id', req.user.sub)
        .setHeader('Authorization', req.headers.authorization)
        .select();
    if(error){
        error.status = 500;
        error.message = `개인 장소 수정 실패: ${error.message}`;
        return next(error);
    }
    return res.status(200).json({
        success: true,
        data: data[0]
    });

})

router.post('/favorite', verifySupabaseJWT,async (req, res) => {
    console.log('[라우트 호출] POST /spaces/favorite');
    const { space_id: initial_space_id, is_public = true, name, address } = req.body;
    let space_id = initial_space_id;

    if (is_public) {
        // --- Public Space Logic ---
        if (!space_id) {
            const err = new Error("공공 장소의 경우 장소 ID(space_id)가 필요합니다.");
            err.status = 400;
            return next(err);
        }
        // Ensure the public space exists in our 'spaces' table.
        const { error: spaceError } = await supabase
            .from('spaces')
            .upsert({ id: space_id, is_public: true })
            .setHeader('Authorization', req.headers.authorization);

        if (spaceError) {
            spaceError.status = 500;
            spaceError.message = `공간 정보 저장 실패: ${spaceError.message}`;
            return next(spaceError);
        }
    } else {
        // --- Private Space Logic ---
        if (!name || !address) {
            const err = new Error("개인 장소의 경우 이름(name)과 주소(address)가 필요합니다.");
            err.status = 400;
            return next(err);
        }

        // 사적 장소 중에서 이름이 일치하는 장소가 있는지 조회
        const { data: existingSpace, error: selectError } = await supabase
            .from('spaces')
            .select('id')
            .eq('user_id', req.user.sub)
            .eq('name', name)
            .eq('is_public', false)
            .maybeSingle(); 

        if (selectError) {
            selectError.status = 500;
            selectError.message = `개인 장소 조회 실패: ${selectError.message}`;
            return next(selectError);
        }

        if (existingSpace) {
            // Use the ID of the existing private space.
            space_id = existingSpace.id;
        } else {
            // Create a new private space as it doesn't exist.
            space_id = uuidv4();
            const newSpaceData = { id: space_id, user_id: req.user.sub, name, address, is_public: false };
            const { error: insertError } = await supabase.from('spaces').insert(newSpaceData).setHeader('Authorization', req.headers.authorization);

            if (insertError) {
                insertError.status = 500;
                insertError.message = `개인 장소 생성 실패: ${insertError.message}`;
                return next(insertError);
            }
        }
    }

    const { error: favoriteError } = await supabase
        .from('favorite_spaces') 
        .upsert({ space_id: space_id, user_id: req.user.sub })
        .setHeader('Authorization', req.headers.authorization);

    if (favoriteError) {
        favoriteError.status = 500;
        favoriteError.message = `즐겨찾기 추가 실패: ${favoriteError.message}`;
        return next(favoriteError);
    }

    return res.status(201).json({ success: true, message: "즐겨찾기에 추가되었습니다.", space_id });
});

router.post('/private-space', verifySupabaseJWT, async (req, res, next) => {
    console.log('[라우트 호출] POST /spaces/private-space');
    const { name, address, lat, lng } = req.body;
    if (!name || !address || !lat || !lng) {
        const err = new Error("개인 장소의 경우 이름(name)과 주소(address), 위도(lat), 경도(lng)가 필요합니다.");
        err.status = 400;
        return next(err);
    }
    let space_id;

    // 사적 장소 중에서 이름이 일치하는 장소가 있는지 조회
    const { data: existingSpace, error: selectError } = await supabase
        .from('spaces')
        .select('id')
        .eq('user_id', req.user.sub)
        .eq('name', name)
        .eq('is_public', false)
        .setHeader('Authorization', req.headers.authorization)

    if (selectError) {
        selectError.status = 500;
        selectError.message = `개인 장소 조회 실패: ${selectError.message}`;
        console.error(selectError);
        return next(selectError);
    }

    if (existingSpace && existingSpace.length > 0) {
        // 기존 장소가 이미 있으면 그 ID를 사용
        space_id = existingSpace[0].id;
    } else {
        // 새로운 개인 장소 생성
        space_id = uuidv4();
        const newSpaceData = { id: space_id, user_id: req.user.sub, name, address, lat, lng, is_public: false };
        const { error: insertError } = await supabase.from('spaces').insert(newSpaceData).setHeader('Authorization', req.headers.authorization);

        if (insertError) {
            insertError.status = 500;
            insertError.message = `개인 장소 생성 실패: ${insertError.message}`;
            return next(insertError);
        }
    }


    return res.status(201).json({ success: true, message: "개인 장소가 업데이트되었습니다.", space_id });
});

router.delete('/favorite', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] DELETE /spaces/favorite');
    const { space_id } = req.body;
    if (!space_id) {
        const err = new Error("장소 ID가 필요합니다.");
        err.status = 400;
        return next(err);
    }

    // favorite_spaces 테이블에서 사용자-장소 관계 삭제
    const { error } = await supabase
    .from('favorite_spaces') // 테이블명 일관성을 위해 favorite_spaces로 변경
    .delete()
    .eq('user_id', req.user.sub)
    .eq('space_id', space_id)
    .setHeader('Authorization', req.headers.authorization);

    if (error) {
        error.status = 500;
        error.message = `즐겨찾기 삭제 실패: ${error.message}`;
        return next(error);
    }

    return res.status(200).json({ success: true, message: "즐겨찾기에서 삭제되었습니다." });
})

router.get('/favorite', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /spaces/favorite');
    
    const { data, error } = await supabase
        .from('favorite_spaces') // 테이블명 일관성을 위해 favorite_spaces로 변경
        .select('space_id').setHeader('Authorization', req.headers.authorization);
    if(error){
        error.status = 500;
        error.message = `즐겨찾기 조회 실패: ${error.message}`;
        return next(error);
    }
    return res.status(200).json({
        success: true,
        favorite_spaces: data.map(item => item.space_id)
    }); 
})
// 에러 핸들링 미들웨어
router.use((err, req, res, next) => {
    console.error('[Space Router Error]', err);
    const status = err.status || 500;
    const message = status === 400 ? (err.message || '잘못된 요청입니다.') : '서버 오류';
    return res.status(status).json({ error: message });
});
    


export default router;

// 거리 계산 함수
// 위도, 경도를 이용해 두 지점 사이의 거리를 계산하는 함수
// Haversine 공식을 사용하여 미터 단위로 반환
function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 지구 반지름 (미터 단위)
  const toRad = (deg) => deg * (Math.PI / 180);

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance; // 결과: 미터 단위 거리
}
