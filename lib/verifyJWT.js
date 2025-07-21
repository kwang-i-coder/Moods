import jwt from "jsonwebtoken";

function verifySupabaseJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "토큰이 누락되었음" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET); 
    req.user = decoded; // user.id, email 등
    next();
  } catch (err) {
    return res.status(403).json({ error: "유효하지 않은 토큰" });
  }
}

export default verifySupabaseJWT;