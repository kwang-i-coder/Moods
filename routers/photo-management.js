import express from "express";
import crypto from "crypto";
import multer from "multer";
import sharp from "sharp";
import supabase from "../lib/supabaseClient.js";
import supabaseAdmin from "../lib/supabaseAdmin.js";
import verifySupabaseJWT from "../lib/verifyJWT.js";
import redisClient from "../lib/redisClient.js";


const router = express.Router();

//업로드 설정, 이미지 MIME만 허용
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 
            'image/jpg',
            'image/png', 
            'image/webp', 
            'image/heic', 
            'image/heif'
        ];
        const ok = allowedTypes.includes(file.mimetype);
        cb(ok ? null : new Error('JPG, PNG, WebP, HEIC, HEIF 형식만 허용합니다.'), ok);
    }
});

// 본인 기록인지 확인
async function assertOwnRecord(recordID, req) {
    console.log('assertOwnRecord 호출:', { recordID, userSub: req.user?.sub }); // 디버깅 로그
    const { data: rec, error } = await supabase
        .from('study_record')
        .select('id, user_id')
        .eq('id', recordID)
        .single()
        .setHeader('Authorization', req.headers.authorization);
    
    console.log('DB 조회 결과:', { rec, error }); // 디버깅 로그
    
    if (error || !rec || rec.user_id !== req.user.sub) {
        const e = new Error('기록을 찾을 수 없거나 권한이 없습니다.');
        e.status = 403;
        throw e;
    }
    return rec;
}

// 경로 생성
const buildPath = (userID, recordID) =>
    `${userID}/${recordID}/${crypto.randomUUID()}.webp`;

// 사진 업로드 (1장만 허용)
router.post('/records/:recordId', verifySupabaseJWT, upload.single('file'), async(req, res) => {
    console.log('[라우트 호출] POST /photos/records/:recordId');
    try {
        const { recordId } = req.params;
        console.log('받은 recordId:', recordId, typeof recordId); // 디버깅 로그
        await assertOwnRecord(recordId, req);
        
        // 입력값 검증
        if (!recordId) {
            return res.status(400).json({ error: '기록ID가 필요합니다.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: '업로드 할 파일이 없습니다.' });
        }

        // 기존 사진이 있는지 체크 (Admin 클라이언트 사용)
        const { data: existingPhoto, error: existingError } = await supabaseAdmin
            .from('record_photos')
            .select('id')
            .eq('record_id', recordId)
            .single();

        // 에러가 있는데 '데이터 없음' 에러가 아니면 실제 에러
        if (existingError && existingError.code !== 'PGRST116') {
            throw existingError;
        }

        if (existingPhoto) {
            return res.status(400).json({ error: '이미 사진이 등록되어 있습니다. 기존 사진을 삭제 후 업로드해주세요.' });
        }

        // 이미지 처리 (HEIF 지원 포함)
        let processed;
        try {
            const sharpInstance = sharp(req.file.buffer);
            
            // HEIF 파일인지 확인
            const metadata = await sharpInstance.metadata();
            console.log('이미지 메타데이터:', {
                format: metadata.format,
                width: metadata.width,
                height: metadata.height,
                size: req.file.size
            });

            processed = await sharpInstance
                .rotate() // EXIF 회전 정보 자동 적용
                .resize({ 
                    width: 2000, 
                    height: 2000, 
                    fit: 'inside', 
                    withoutEnlargement: true 
                })
                .webp({ quality: 82 })
                .toBuffer();
                
        } catch (sharpError) {
            console.error('Sharp 처리 에러:', sharpError);
            
            if (sharpError.message.includes('heif') || 
                sharpError.message.includes('HEIC') ||
                sharpError.message.includes('libheif') ||
                sharpError.message.includes('compression format')) {
                throw new Error('HEIC/HEIF 파일 처리를 위한 라이브러리가 설치되지 않았습니다. 서버 관리자에게 문의하거나 JPG/PNG 형식을 사용해주세요.');
            }
            
            // 일반적인 Sharp 에러
            if (sharpError.message.includes('Input buffer contains unsupported image format')) {
                throw new Error('지원되지 않는 이미지 형식입니다. JPG, PNG, WebP 형식을 사용해주세요.');
            }
            
            throw new Error('이미지 처리 중 오류가 발생했습니다: ' + sharpError.message);
        }

        const meta = await sharp(processed).metadata();
        const path = buildPath(req.user.sub, recordId);

        // Storage 업로드
        const { error: uploadError } = await supabaseAdmin.storage
            .from('study-photos')
            .upload(path, processed, { contentType: 'image/webp', upsert: false });
        
        if (uploadError) throw uploadError;

        // DB 저장
        const { data: row, error: insertError } = await supabase
            .from('record_photos')
            .insert({
                record_id: recordId,
                path,
                width: meta.width || null,
                height: meta.height || null,
                size_bytes: processed.length,
                mime_type: 'image/webp'
            })
            .select()
            .single()
            .setHeader('Authorization', req.headers.authorization);

            if (updateError) {
                console.error('업데이트 실패', updateError);
            }
            
        if (insertError) {
            // Storage 롤백
            await supabaseAdmin.storage.from('study-photos').remove([path]).catch((rollbackErr) => {
                console.error('Storage 롤백 실패:', rollbackErr);
            });
            throw insertError;
        }

        res.status(201).json({ success: true, photo: row });
    } catch (err) {
        console.error('사진 업로드 에러:', err);
        res.status(err.status || 500).json({ error: err.message || '업로드 실패' });
    }
});

// 사진 조회
router.get('/records/:recordId', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] GET /photos/records/:recordId');
    try {
        const { recordId } = req.params;
        await assertOwnRecord(recordId, req);

        const { data: photo, error } = await supabaseAdmin
            .from('record_photos')
            .select('id, path, created_at')
            .eq('record_id', recordId)
            .single();

        // 데이터가 없는 경우는 정상 (null 반환)
        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        if (!photo) {
            return res.json({ success: true, photo: null });
        }

        // Signed URL 생성
        const { data: signedData, error: signedError } = await supabaseAdmin.storage
            .from('study-photos')
            .createSignedUrl(photo.path, 60 * 60 * 60 * 60);
        
        if (signedError) throw signedError;

        const result = {
            ...photo,
            url: signedData.signedUrl
        };

        res.json({ success: true, photo: result });
    } catch (err) {
        console.error('사진 조회 에러:', err);
        res.status(err.status || 500).json({ error: err.message || '조회 실패' });
    }
});

// 사진 삭제
router.delete('/:photoId', verifySupabaseJWT, async (req, res) => {
    console.log('[라우트 호출] DELETE /:photoId');
    try {
        const { photoId } = req.params;

        if (!photoId) {
            return res.status(400).json({ error: '사진ID가 필요합니다.' });
        }

        const { data: photo, error } = await supabaseAdmin
            .from('record_photos')
            .select('id, record_id, path')
            .eq('id', photoId)
            .single();
            
        if (error || !photo) {
            return res.status(404).json({ error: '사진을 찾을 수 없습니다.' });
        }

        // 내 기록인지 확인
        await assertOwnRecord(photo.record_id, req);

        // DB 먼저 삭제 (실패하면 Storage 삭제 안함)
        const { error: deleteError } = await supabase
            .from('record_photos')
            .delete()
            .eq('id', photoId)
            .setHeader('Authorization', req.headers.authorization);

        if (deleteError) throw deleteError;

        // DB 삭제 성공하면 Storage 삭제
        const { error: storageError } = await supabaseAdmin.storage
            .from('study-photos')
            .remove([photo.path]);

        if (storageError) {
            console.error('Storage 삭제 실패 (DB는 이미 삭제됨):', storageError);
            // Storage 삭제 실패해도 200 반환 (DB는 정리됨)
        }

        res.json({ success: true });
    } catch (err) {
        console.error('사진 삭제 에러:', err);
        res.status(err.status || 500).json({ error: err.message || '삭제 실패' });
    }
});

router.get('/wallpaper', verifySupabaseJWT, async (req, res) => {
    // const header = {
    //     "Content-Type": "application/json",
    // }
    // const body = {
    //     title: query.trim()
    // }
    // const response = await fetch("http://localhost:8000/tasks/wallpaper", {method:"POST", headers:header, body:JSON.stringify(body)})

    const redis_key = `sessions:${req.user.sub}`
    const sess = await redisClient.hGetAll(redis_key);
    if(Object.keys(sess).length === 0) return res.status(400).json({ error: '세션이 없습니다.' });

    const mood_id = JSON.parse(sess.mood_id).map(tag => tag.trim()) || [];
    if(mood_id.length === 0){
        const { data:url, error } = await supabaseAdmin
            .storage
            .from('wallpaper')
            .createSignedUrl('general/Rectangle 34627910.png', 60)

        if (error) {
            console.error('Wallpaper URL 생성 실패:', error);
            return res.status(500).json({ error: 'Wallpaper URL 생성 실패' });
        }
        return res.json({ success: true, data:{url: url.signedUrl }});
    }

    const { data:mood_tags_data, error:mood_tags_error } = await supabaseAdmin
        .from('mood_tags')
        .select('*')
    if (mood_tags_error) {
        console.error('Mood tags 조회 실패:', mood_tags_error);
        return res.status(500).json({ error: 'Mood tags 조회 실패' });
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
            return res.status(500).json({ error: 'Wallpaper 목록 조회 실패' });
        }
        const names = data.map(item => `${tag}/${item.name}`);
        wallpaper_name.push(...names);
    }
    console.log('선택된 Wallpaper 후보:', wallpaper_name);
    // 랜덤으로 하나 전송
    const randomWallpaper = wallpaper_name[Math.floor(Math.random() * wallpaper_name.length)];
    console.log('선택된 랜덤 Wallpaper:', randomWallpaper);
    const { data: signedUrl, error: urlError } = await supabaseAdmin.storage.from('wallpaper').createSignedUrl(randomWallpaper, 60);
    if (urlError) {
        console.error('Wallpaper URL 생성 실패:', urlError);
        return res.status(500).json({ error: 'Wallpaper URL 생성 실패' });
    }
    res.json({ success: true, data: { url: signedUrl.signedUrl } });
})

export default router;