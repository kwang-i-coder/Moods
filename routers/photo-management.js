import express from "express";
import crypto from "crypto";
import multer from "multer";
import sharp from "sharp";
import supabase from "../lib/supabaseClient.js";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import verifySupabaseJWT from "../lib/verifyJWT.js";

const router = express.Router();

//업로드 설정, 이미지 MIME만 허용
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.mimetype);
        cb(ok ? null : new Error('이미지 형식만 허용합니다.'), ok);
    }
});

// 본인 기록인지 확인
async function assertOwnRecord(recordID, req) {
    const { data: rec, error } = await supabase
        .from('study_record')
        .select('id, user_id')
        .eq('id', recordID)
        .single()
        .setHeader('Authorization', req.headers.authorization);
    if (error || !rec || rec.user_id !== req.user.sub) {
        const e = new Error('기록을 찾을 수 없거나 권한이 없습니다.');
        e.status = 403;
        throw e;
    }
    return rec;
}

// 경로 생성
const buildPath = (userID, recordID, suffix) =>
    `${userID}/${recordID}/${crypto.randomUUID()}_${suffix}.webp`;

// 사진 업로드
// 원본 -> 리사이즈 -> webp 변환 및 썸네일 생성 후 스토리즈 업로드
router.post('/records/:recordId', verifySupabaseJWT, upload.array('files', 5), async(req, res) => {
    console.log('[라우트 호출] POST /photos/records/:recordId');
    try {
        const { recordId } = req.params;
        await assertOwnRecord(recordId, req);
        
        // 입력값 검증
        if (!recordId || isNaN(recordId)) {
            return res.status(400).json({ error: '유효하지 않은 기록ID입니다.' });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: '업로드 할 파일이 없습니다. '});
        }

        // 현재 사진 개수 체크
        const { count } = await supabase
            .from('record_photos')
            .select('id', { count: 'exact', head: true })
            .eq('record_id', recordId)
            .setHeader('Authorization', req.headers.authorization);

        const remain = 10 - (count ?? 0);
        if (remain <= 0) return res.status(400).json({ error: '최대 10장까지 업로드할 수 있습니다.' });
        if (req.files.length > remain) return res.status(400).json({ error: `남은 업로드 가능: ${remain}장` });

        const uploaded = [];

        for (const file of req.files) {
            // 이미지 리사이즈
            const original = await sharp(file.buffer)
                .rotate()
                .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true})
                .webp({ quality: 82 })
                .toBuffer();

            const meta = await sharp(original).metadata();

            // 썸네일 생성
            const thumb = await sharp(original)
                .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true})
                .webp({ quality: 78 })
                .toBuffer();

            // 경로 생성
            const path = buildPath(req.user.sub, recordId, 'orig');
            const thumbPath = buildPath(req.user.sub, recordId, 'thumb');

            // Storage 업로드
            const up1 = await supabaseAdmin.storage.from('study-photos')
                .upload(path, original, { contentType: 'image/webp', upsert: false});
            if(up1.error) throw up1.error;

            const up2 = await supabaseAdmin.storage.from('study-photos')
                .upload(thumbPath, thumb, {contentType: 'image/webp', upsert: false});
            if (up2.error) {
                // 원본 롤백
                await supabaseAdmin.storage.from('study-photos').remove([path]).catch((rollbackError) => {
                    console.error('파일 삭제롤백 실패:', rollbackError);
                });
                throw up2.error;
            }

            // DB 저장
            const { data: row, error: insErr} = await supabase
                .from('record_photos')
                .insert({
                    record_id: recordId,
                    path,
                    thumb_path: thumbPath,
                    width: meta.width || null,
                    height: meta.height || null,
                    size_bytes: original.length,
                    mime_type: 'image/webp'
                })
                .select()
                .single()
                .setHeader('Authorization', req.headers.authorization);
            
            if (insErr) {
                // 스토리지 롤백
                await supabaseAdmin.storage.from('study-photos').remove([path, thumbPath]).catch(() => {});
                throw insErr;
            }

            uploaded.push(row);
        }

        res.status(201).json({ success: true, photos: uploaded});
    } catch (err) {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || '업로드 실패'});
    }
});

// 사진 목록
router.get('/records/:recordId', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /photos/records/:recordId');
    try {
        const { recordId } = req.params;
        await assertOwnRecord(recordId, req);

        const { data: photos, error } = await supabase
            .from('record_photos')
            .select('id, path, thumb_path, is_thumbnail, created_at')
            .eq('record_id', recordId)
            .order('created_at', { ascending: true })
            .setHeader('Authorization', req.headers.authorization);

        if (error) throw error;

        const signed = await Promise.all(photos.map(async p => {
            const orig = await supabaseAdmin.storage.from('study-photos').createSignedUrl(p.path, 60 * 5);
            const thmb = p.thumb_path
                ? await supabaseAdmin.storage.from('study-photos').createSignedUrl(p.thumb_path, 60 * 5)
                : { data: { signedUrl: null}};
            return {
                ...p,
                url: orig.data?.signedUrl || null,
                thumb_url: thmb.data?.signedUrl || null
            };
        }));

        res.json({ success: true, photos: signed });
    } catch (err) {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || '조회 실패'});
    }
});

// 사진 삭제 (스토리지 + DB)
router.delete('/:photoId', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] DELETE /:photoId');
    try {
        const { photoId } = req.params;

        const { data: photo, error } = await supabase
            .from('record_photos')
            .select('id, record_id, path, thumb_path')
            .eq('id', photoId)
            .single()
            .setHeader('Authorization', req.headers.authorization);
        if (error || !photo) return res.status(404).json({ error: '사진을 찾을 수 없습니다.' });

        // 내 기록인지 확인
        await assertOwnRecord(photo.record_id, req);

        // Storage 삭제
        await supabaseAdmin.storage.from('study-photos').remove([photo.path, photo.thumb_path].filter(Boolean));
        // DB 삭제
        await supabase.from('study-photos').delete().eq('id', photoId).setHeader('Authorization', req.headers.authorization);

        res.json({success: true});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: '삭제 실패'});
    }
});

// 대표 사진 지정
router.patch('/:photoId/thumbnail', verifySupabaseJWT, async (req, res) => {
        console.log('[라우터 호출] PATCH/:photoId/thumbnail');
        try {
            const { photoId } = req.params;

            const { data: photo, error } = await supabase
                .from('record_photos')
                .select('id, record_id')
                .eq('id', photoId)
                .single()
                .setHeader('Authorization', req.headers.authorization);
            if (error || !photo) return res.status(404).json({ error: '사진을 찾을 수 없습니다. '});

            await assertOwnRecord(photo.record_id, req);

            // 하나 제외 전부 false로 설정
            await supabase.from('record_photos')
                .update({ is_thumbnail: false })
                .eq('record_id', photo.record_id)
                .setHeader('Authorization', req.headers.authorization);
            
            // 썸네일 하나만 true
            await supabase
                .from('record_photos')
                .update({ is_thumbnail: true })
                .eq('id', photoId)
                .setHeader('Authorization', req.headers.authorization);
            if (upErr) throw upErr;

            res.json({ success: true, photo: updated });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error : '썸네일 지정 실패'});
        }
    });

export default router;