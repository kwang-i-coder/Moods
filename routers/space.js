import express from "express"
import supabase from "../lib/supabaseClient.js"
import verifySupabaseJWT from "../lib/verifyJWT.js";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

router.use(express.json());

router.get('/near', async (req, res) => {
    console.log('[라우트 호출] GET /spaces/near');
    // 근처 장소 조회 라우트
    var {lat, lng, rad, type} = req.query;
    // lat, lng는 필수 파라미터
    if(!lat || !lng) {
        return res.status(400).json({error: "위치 정보가 부족합니다."});
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
    "X-Goog-FieldMask": "places.location,places.id,places.displayName,places.types"
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
                for(const t of type) {
                    if(result[idx].types.includes(t)) {
                        data.type = t;
                        break; // 모든 타입을 추가
                    }
                }
                result[idx] = data;
            }
            // 거리 기준으로 정렬
            result.sort((a, b) => a.distance - b.distance);
        }
        return res.status(200).json({
            success: true,
            places: result
        });
    } catch (error) {
        console.error("근처 장소 조회 오류:", error);
        return res.status(500).json({error: "서버 오류"});
    }
})

router.get('/detail', async (req, res) => {
    console.log('[라우트 호출] GET /spaces/detail');
    // 장소 상세 정보 조회 라우트
    var { space_id } = req.query;
    if (!space_id) {
        return res.status(400).json({ error: "장소 ID가 필요합니다." });
    }
    if(!Array.isArray(space_id)) {
        space_id = [space_id]; // 단일 ID를 배열로 변환
    }

    
    const headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
        "X-Goog-FieldMask": "displayName.text,formattedAddress,types,location",
    };
    var response_data = {
        success: true,
        data: []
    };

    for(const id of space_id) {
        const url = `https://places.googleapis.com/v1/places/${id}?languageCode=ko&regionCode=kr`;
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: headers
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const result = await response.json();
            if (!result) {
                return res.status(404).json({ error: "장소를 찾을 수 없습니다." });
            }

            // 장소 정보 가공
            const spaceData = {
                space_id: result.id,
                name: result.displayName.text,
                formatted_address: result.formattedAddress,
                types: "",
                location: {lat: result.location.latitude, lng: result.location.longitude}
            };
            for(const t of result.types) {
                if(['cafe', 'library'].includes(t)) {
                    spaceData.types = t;
                    break; // 첫 번째 타입만 추가
                }
            }
            response_data.data.push(spaceData);
        } catch (error) {
            console.error("장소 상세 정보 조회 오류:", error);
            return res.status(500).json({ error: "서버 오류" });
    }
    }
    return res.status(200).json(response_data);
})

router.get('/visited', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /spaces/visited');
    const {from, to} = req.query;
    try {
        // 사용자 공부 기록에서 방문한 장소 조회
        const {data, error} = await supabase
            .from('visited_spaces')
            .select('space_id')
            .gte('recent_visit', from)
            .lte('recent_visit', to)
            .setHeader('Authorization', req.headers.authorization);
        if (error) {
            return res.status(400).json({ error: error.message });
        }
        res.json({
            success: true,
            visited_spaces: data.map(item => item.space_id)
        });
    } catch (error) {
        console.error("방문 장소 조회 오류:", error);
        return res.status(500).json({error: "서버 오류"});
    }
});

router.post('/favorite', verifySupabaseJWT,async (req, res) => {
    console.log('[라우트 호출] POST /spaces/favorite');
    const { space_id: initial_space_id, is_public = true, name, address } = req.body;
    let space_id = initial_space_id;

    if (is_public) {
        // --- Public Space Logic ---
        if (!space_id) {
            return res.status(400).json({ error: "공공 장소의 경우 장소 ID(space_id)가 필요합니다." });
        }
        // Ensure the public space exists in our 'spaces' table.
        const { error: spaceError } = await supabase
            .from('spaces')
            .upsert({ id: space_id, is_public: true })
            .setHeader('Authorization', req.headers.authorization);

        if (spaceError) {
            console.error('공공 장소 정보 upsert 오류:', spaceError);
            return res.status(500).json({ error: `공간 정보 저장 실패: ${spaceError.message}` });
        }
    } else {
        // --- Private Space Logic ---
        if (!name || !address) {
            return res.status(400).json({ error: "개인 장소의 경우 이름(name)과 주소(address)가 필요합니다." });
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
            console.error('개인 장소 조회 오류:', selectError);
            return res.status(500).json({ error: `개인 장소 조회 실패: ${selectError.message}` });
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
                console.error('개인 장소 생성 오류:', insertError);
                return res.status(500).json({ error: `개인 장소 생성 실패: ${insertError.message}` });
            }
        }
    }

    const { error: favoriteError } = await supabase
        .from('favorite_spaces') 
        .upsert({ space_id: space_id, user_id: req.user.sub })
        .setHeader('Authorization', req.headers.authorization);

    if (favoriteError) {
        console.error('즐겨찾기 추가 Supabase 오류:', favoriteError);
        return res.status(500).json({ error: `즐겨찾기 추가 실패: ${favoriteError.message}` });
    }

    return res.status(201).json({ success: true, message: "즐겨찾기에 추가되었습니다.", space_id });
});

router.delete('/favorite', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] DELETE /spaces/favorite');
    const { space_id } = req.body;
    if (!space_id) {
        return res.status(400).json({ error: "장소 ID가 필요합니다." });
    }

    // favorite_spaces 테이블에서 사용자-장소 관계 삭제
    const { error } = await supabase
    .from('favorite_spaces') // 테이블명 일관성을 위해 favorite_spaces로 변경
    .delete()
    .eq('user_id', req.user.sub)
    .eq('space_id', space_id)
    .setHeader('Authorization', req.headers.authorization);

    if (error) {
        console.error('즐겨찾기 삭제 Supabase 오류:', error);
        return res.status(500).json({ error: `즐겨찾기 삭제 실패: ${error.message}` });
    }

    return res.status(200).json({ success: true, message: "즐겨찾기에서 삭제되었습니다." });
})

router.get('/favorite', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /spaces/favorite');
    
    const { data, error } = await supabase
        .from('favorite_spaces') // 테이블명 일관성을 위해 favorite_spaces로 변경
        .select('space_id').setHeader('Authorization', req.headers.authorization);
    if(error){
        console.error('즐겨찾기 조회 Supabase 오류:', error);
        return res.status(500).json({ error: `즐겨찾기 조회 실패: ${error.message}` });
    }
    return res.status(200).json({
        success: true,
        favorite_spaces: data.map(item => item.space_id)
    }); 
})

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
