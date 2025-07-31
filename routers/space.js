import express from "express"
import supabase from "../lib/supabaseClient.js"
import verifySupabaseJWT from "../lib/verifyJWT.js";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import fetch from "node-fetch";

const router = express.Router();

router.use(express.json());

router.get('/near', async (req, res) => {
    // 근처 장소 조회 라우트
    const {lat, lng, rad, type} = req.query;
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
                for(const t of result[idx].types) {
                    if(t in type) {
                        data.type = t; // 첫 번째 타입을 사용
                        break;
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

export default router;

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
