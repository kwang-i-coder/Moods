import express from 'express';
import supabase from '../lib/supabaseClient.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import verifySupabaseJWT from '../lib/verifyJWT.js';

const router = express.Router();

// 사용자의 총 공부 횟수
router.get('/my-summary', verifySupabaseJWT, async(req, res) => {
    console.log('[라우터 호출] GET /stats/my-summary')
    try {
        const userId = req.user.sub;

    // 총 횟수 (COUNT)
    const { count: totalCount, error: countErr } = await supabase
        .from("study_record")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .setHeader('Authorization', req.headers.authorization);
    
    if (countErr) throw countErr;

    // 총 시간 / 최초 / 최신
    const { data: aggRows, error: aggErr } = await supabase
        .from("study_record")
        .select("duration, created_at")
        .eq("user_id", userId)
        .order('created_at', { ascending: true })
        .setHeader('Authorization', req.headers.authorization);
    
    if (aggErr) throw aggErr;

    let totalMinutes = 0;
    let firstDate = null;
    let lastDate = null;

    if (aggRows && aggRows.length > 0) {
        // 첫 번째와 마지막 날짜는 정렬된 데이터에서 바로 추출
        firstDate = new Date(aggRows[0].created_at).toISOString();
        lastDate = new Date(aggRows[aggRows.length - 1].created_at).toISOString();

        // 총 시간 계산
        totalMinutes = aggRows.reduce((sum, record) => {
            return sum + Number(record.duration || 0);
        }, 0);
    }

    return res.json({
        success: true,
        total_study_count: totalCount ?? 0,
        total_duration_minutes: totalMinutes,
        total_duration_hours: +(totalMinutes / 60).toFixed(2),
        first_study_date: firstDate,
        last_study_date: lastDate,
    });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "총 공부 횟수 조회 실패" });
    }
});

// 나의 공간별 집계
router.get("/my/spaces", verifySupabaseJWT, async (req, res) => {
    console.log('[라우터 호출] GET /stats/my/spaces')
    try {
        const userId = req.user.sub;
        const sort = (req.query.sort || "counts").toLowerCase();
        const limit = Number(req.query.limit || 50, 100);

        // 내 기록만 가져오기
        const { data: rows, error } = await supabase
            .from('study_record')
            .select("space_id, duration")
            .eq("user_id", userId)
            .setHeader('Authorization', req.headers.authorization);
        
        if (error) throw error;

        // Google Place ID 기준 집계
        const spaceStats = new Map();

        for (const record of rows) {
            const spaceId = record.space_id;
            if (!spaceStats.has(spaceId)) {
                spaceStats.set(spaceId, {
                    space_id: spaceId,
                    study_count: 0,
                    total_minutes: 0
                });
            }

            const stats = spaceStats.get(spaceId);
            stats.study_count += 1;
            stats.total_minutes += Number(record.duration || 0);
        }

        // 상위 N개 정렬
        const sortedList = Array.from(spaceStats.values());
        sortedList.sort((a, b) => {
            if (sort === "minutes") {
                return b.total_minutes - a.total_minutes;
            }
            return b.study_count - a.study_count;
        });
        
        // 시간 정보 추가
        const result = sortedList.slice(0, limit).map(item => ({
            ...item,
            total_hours: +(item.total_minutes / 60).toFixed(2)
        }));

        return res.json({
            success: true,
            items: result,
            sort,
            limit,
            total_spaces: spaceStats.size
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: '공간별 집계 조회 실패' });
    }
});

router.get("/my/spaces-ranks", verifySupabaseJWT, async (req, res) => {
    console.log('[라우터 호출] GET /stats/my/spaces-ranks')
    try {
        const userId = req.user.sub;

        // 내가 공부한 공간들 조회
        const { data: mySpaces, error: mySpacesError } = await supabase
            .from("study_record")
            .select("space_id")
            .eq("user_id", userId)
            .setHeader('Authorization', req.headers.authorization);;

        if (mySpacesError) throw mySpacesError;


        const mySpaceIds = [ ...new Set(mySpaces.map(s => s.space_id))];

        if (mySpaceIds.length === 0) {
            return res.json({ success: true, items: [] });
        } 

        // 내가 공부한 공간들의 모든 유저 데이터 조회
        const { data: rows, error } = await supabase
            .from("study_record")
            .select("space_id, user_id, duration")
            .in("space_id", mySpaceIds); // 필요한 공간만 조회

        if (error) throw error;

        // 공간별 유저 집계
        const spaceUserStats = new Map();

        for (const record of rows) {
            const spaceId = record.space_id;
            const userId = record.user_id;

            if (!spaceUserStats.has(spaceId)) {
                spaceUserStats.set(spaceId, new Map());
            }

            const userMap = spaceUserStats.get(spaceId);
            if (!userMap.has(userId)) {
                userMap.set(userId, {
                    user_id: userId,
                    study_count: 0,
                    total_minutes: 0
                });
            }

            const userStats = userMap.get(userId);
            userStats.study_count += 1;
            userStats.total_minutes += Number(record.duration || 0);
        }

        // 공간별 랭킹 계산 후 내 순위 추출
        const myRanks = [];
        
        for (const [spaceId, userMap] of spaceUserStats.entries()) {
            const userList = Array.from(userMap.values());

            // 랭킹 정렬
            userList.sort((a, b) => {
                if (b.study_count !== a.study_count) {
                    return b.study_count - a.study_count;
                }
                return b.total_minutes - a.total_minutes;
            });

            const totalUsers = userList.length;
            const myIndex = userList.findIndex(user => user.user_id === userId);

            if (myIndex >= 0) {
                const myStats = userList[myIndex];
                myRanks.push({
                    space_id: spaceId,
                    user_rank: myIndex + 1,
                    total_users: totalUsers,
                    my_study_count: myStats.study_count,
                    my_total_minutes: myStats.total_minutes,
                    my_total_hours: +(myStats.total_minutes / 60).toFixed(2),
                    rank_percentage: +((myIndex + 1) / totalUsers * 100).toFixed(1)
                });
            }
        }

        // 랭킹 순으로 정렬
        myRanks.sort((a, b) => a.user_rank - b.user_rank)

        return res.json({
            success: true,
            items: myRanks,
            total_ranked_spaces: myRanks.length
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: '공간 랭킹 조회 실패' });
    }
});

export default router;