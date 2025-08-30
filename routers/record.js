import express from "express";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import supabase from "../lib/supabaseClient.js"
import verifySupabaseJWT from "../lib/verifyJWT.js";

const router = express.Router();
router.use(verifySupabaseJWT);

//  태그 정보를 가져오는 헬퍼 함수 추가
const getTagsForRecords = async (recordIds, authorization) => {
    if (!recordIds || recordIds.length === 0) return {};
    
    try {
        // record_tags에서 record_id별 tag_id들을 가져옴
        const { data: recordTag, error: recordTagError } = await supabase
            .from("record_tag")
            .select("record_id, tag_id")
            .in("record_id", recordIds)
            .setHeader('Authorization', authorization);

        if (recordTagError) {
            console.error("record_tags 조회 오류:", recordTagError);
            return {};
        }

        // 모든 tag_id를 수집
        const tagIds = [...new Set(recordTag.map(rt => rt.tag_id))];
        
        if (tagIds.length === 0) return {};

        // tags 테이블에서 실제 태그 정보를 가져옴
        const { data: tags, error: tagsError } = await supabase
            .from("tags")
            .select("id, name, color")
            .in("id", tagIds)
            .setHeader('Authorization', authorization);

        if (tagsError) {
            console.error("tags 조회 오류:", tagsError);
            return {};
        }

        // tag_id를 키로 하는 태그 맵 생성
        const tagMap = {};
        tags.forEach(tag => {
            tagMap[tag.id] = tag;
        });

        // record_id별로 태그들을 그룹화
        const recordTagMap = {};
        recordTag.forEach(rt => {
            if (!recordTagMap[rt.record_id]) {
                recordTagMap[rt.record_id] = [];
            }
            if (tagMap[rt.tag_id]) {
                recordTagMap[rt.record_id].push(tagMap[rt.tag_id]);
            }
        });

        return recordTagMap;
    } catch (error) {
        console.error("태그 조회 중 오류:", error);
        return {};
    }
};

// record 조회 (사용자별, 날짜별))
router.get("/records", verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /record/records');
    const { date, user_id, space_id } = req.query;
    if (!user_id) {
        return res.status(400).json({ error: "사용자 ID는 필수입니다." });
    }

    try {
        let query = supabaseAdmin
            .from("study_record")
            .select("*")
            .setHeader("Authorization", req.headers.authorization)

        // 날짜 필터링
        if (date) {
            // 날짜 형식 검증 (YYYY-MM-DD)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(date)) {
                return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)" });
            }

            // 해당 날짜에 시작된 ₩들 조회
            const startOfDay = `${date}T00:00:00.000Z`;
            const endOfDay = `${date}T23:59:59.999Z`;
            
            query = query
                .gte("start_time", startOfDay)
                .lte("end_time", endOfDay);
        }

        // 스페이스 필터링
        if (space_id) {
            query = query.eq("space_id", space_id);
        }

        const { data, error } = await query.order("created_at", { ascending: false });

        if (error) {
            return res.status(500).json({ error: "레코드 조회에 실패했습니다.", details: error.message });
        }

        // 태그 정보 추가
        const recordIds = data.map(record => record.id);
        const tagsMap = await getTagsForRecords(recordIds, req.headers.authorization);
        
        // 각 레코드에 태그 정보 추가
        const recordsWithTags = data.map(record => ({
            ...record,
            tags: tagsMap[record.id] || []
        }));

        res.status(200).json({
            message: "학습 기록을 조회했습니다.",
            count: recordsWithTags.length,
            records: recordsWithTags
        });
    
    } catch (error) {
        console.error("레코드 조회 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

// 기록 캘린더: 특정 연도/월에 해당하는 기록 전체 조회
router.get("/records/calendar", verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /record/records/calendar');
    const { year, month } = req.query;

    // year, month 필수
    if (!year || !month) {
        return res.status(400).json({ error: "연도와 월를 모두 입력해야 합니다." });
    }

    const parsedYear = parseInt(year, 10);
    const parsedMonth = parseInt(month, 10);

    if (isNaN(parsedYear) || isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
        return res.status(400).json({ error: "올바른 연도 및 월을 입력해주세요." });
    }

    try {
        const startDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
        const endDate = new Date(Date.UTC(parsedYear, parsedMonth, 0, 23, 59, 59));

        const { data: records, error } = await supabase
            .from("study_record")
            .select("*")
            .gte("start_time", startDate.toISOString())
            .lte("end_time", endDate.toISOString())
            .order("start_time", { ascending : true })
            .setHeader('Authorization', req.headers.authorization);
    if (error) {
        return res.status(500).json({ error: "기록 캘린더 조회 실패", details: error.message});
    }

    // 태그 정보 추가
    const recordIds = records.map(record => record.id);
    const tagsMap = await getTagsForRecords(recordIds, req.headers.authorization);

    // 날짜별 그룹화
    const recordsByDay = {};
    for (let i = 1; i <= 31; i++) {
        recordsByDay[i] = [];
    }

    for (const record of records) {
        const day = new Date(record.start_time).getUTCDate();
        // 🔴 태그 정보를 포함한 레코드 추가
        recordsByDay[day].push({
            ...record,
            tags: tagsMap[record.id] || []
        });
    }

    res.status(200).json({
        message: "기록 캘린더 데이터를 성공적으로 불러왔습니다.",
        year: parsedYear,
        month: parsedMonth,
        records_by_day: recordsByDay
    });

    } catch (error) {
        console.error("기록 캘린더 조회 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류 발생" });
    }
});

// 단일 record 조회
router.get("/records/:id", verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /record/records:id');
    const { id } = req.params;

    try {
        const { data, error } = await supabase
            .from('study_record')
            .select(`
                id, title, duration, start_time, end_time,
                goals,
                space_id,
                spaces (id, name, type_tags, mood_tags),
                record_tag (tag_id),
                record_emotions (
                  emotion_id,
                  emotions (
                    name
                  )
                ),
                record_photos (path)
            `)
            .eq("id", id)
            .maybeSingle()
            .setHeader('Authorization', req.headers.authorization);

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        // data가 빈 배열인지 확인
        if (!data || data.length === 0) {
            return res.status(404).json({ error: "레코드를 찾을 수 없습니다." });
        }

        // 해당 레코드의 태그 정보 추가
        const tagsMap = await getTagsForRecords([id], req.headers.authorization);
        const recordWithTags = {
            ...data,
            tags: tagsMap[id] || []
        };

        return res.status(200).json({ 
            message: "레코드 조회에 성공했습니다.",
            record: recordWithTags
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "서버 오류" });
    }
});

// record 수정
router.put("/records/:id", verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] PUT /record/records:id');
    const { id } = req.params;
    const { space_id, duration, start_time, end_time, is_public, tags } = req.body; // 🔴 tags 추가

    try {
        // 먼저 레코드가 존재하는지 확인
        const { data: existingRecord, error: checkError } = await supabase
            .from("study_record")
            .select()
            .eq("id", id)
            .setHeader('Authorization', req.headers.authorization)

        if (checkError || !existingRecord) {
            return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
        }

        // 레코드 업데이트를 위한 데이터
        const updateData = {};
        if (space_id) updateData.space_id = space_id;
        if (start_time) updateData.start_time = start_time;
        if (end_time) updateData.end_time = end_time;
        if (duration != null) updateData.duration = duration;
        if (is_public != null) updateData.is_public = is_public;

        // 태그 처리 로직 추가
        if (tags !== undefined) {
            // 기존 태그 관계 삭제
            const { error: deleteTagsError } = await supabaseAdmin
                .from("record_tags")
                .delete()
                .eq("record_id", id);

            if (deleteTagsError) {
                return res.status(500).json({ error: "기존 태그 삭제 실패", details: deleteTagsError.message });
            }

            // 새 태그 관계 추가 (tags가 배열이고 비어있지 않은 경우)
            if (Array.isArray(tags) && tags.length > 0) {
                const tagRelations = tags.map(tagId => ({
                    record_id: id,
                    tag_id: tagId
                }));

                const { error: insertTagsError } = await supabaseAdmin
                    .from("record_tags")
                    .insert(tagRelations);

                if (insertTagsError) {
                    return res.status(500).json({ error: "새 태그 추가 실패", details: insertTagsError.message });
                }
            }
        }

        // 업데이트할 필드가 있는 경우에만 레코드 업데이트
        let updatedRecord = existingRecord;
        if (Object.keys(updateData).length > 0) {
            const { data: updateResult, error: updateError } = await supabaseAdmin
                .from("study_record")
                .update(updateData)
                .eq("id", id)
                .select()
                .setHeader('Authorization', req.headers.authorization)
            
            if (updateError) {
                return res.status(500).json({ error: "레코드 수정 실패.", details: updateError.message });
            }
            updatedRecord = updateResult;
        }

        // 최종 응답에 태그 정보 포함
        const tagsMap = await getTagsForRecords([id], req.headers.authorization);
        const recordWithTags = {
            ...updatedRecord[0],
            tags: tagsMap[id] || []
        };

        return res.status(200).json({ message: "레코드 수정 완료.", record: recordWithTags });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "서버 오류 "});
    }
});
        
// record 삭제
router.delete("/records/:id", verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] DELETE /record/records:id');
    const { id } = req.params;

    try {
        // 기존 레코드 확인
        const { data: existingRecord, error: checkError } = await supabase
            .from("study_record")
            .select()
            .eq("id", id)
            .setHeader('Authorization', req.headers.authorization)
            
        if (checkError || !existingRecord) {
            return res.status(404).json({ error: "해당 레코드를 찾을 수 없습니다." });
        }
        
        // 먼저 관련된 태그 관계 삭제
        const { error: deleteTagsError } = await supabaseAdmin
            .from("record_tags")
            .delete()
            .eq("record_id", id);

        if (deleteTagsError) {
            console.error("태그 관계 삭제 오류:", deleteTagsError);
            // 태그 삭제 실패해도 레코드 삭제는 계속 진행
        }
        
        // 레코드 삭제
        const { error: deleteError } = await supabaseAdmin
            .from("study_record")
            .delete()
            .eq("id", id)

        if (deleteError) {
            return res.status(500).json({ error: "레코드 삭제에 실패했습니다.", details: deleteError.message });
        }

        res.status(200).json({ message: "레코드가 성공적으로 삭제되었습니다." });

    } catch (error) {
        console.error("레코드 삭제 중 오류 발생:", error);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

export default router;