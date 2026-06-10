const buckets = new Map();

function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const now = Date.now();
    const id = key ? key(req) : req.ip;
    const bucketKey = `${req.path}:${id}`;
    const bucket = buckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
    if (bucket.resetAt < now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    buckets.set(bucketKey, bucket);
    if (bucket.count > max) {
      res.status(429).json({ error: "请求过于频繁，请稍后再试" });
      return;
    }
    next();
  };
}

module.exports = { rateLimit };
